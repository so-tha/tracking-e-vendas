import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { DELIVER_CONVERSION } from "../../src/modules/conversions/create.js";
import { PROVIDER_NAMES, type ProviderName } from "../../src/modules/conversions/types.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma, resetDatabase } from "./helpers/db.js";
import { createClock, createTestKit, drain, orderPaid, testOperators, type TestKit, type TestKitOptions } from "./helpers/orders.js";

const prisma = createTestPrisma();
const clock = createClock("2026-01-10T12:00:00.000Z");
const app = createApp({ prisma, logger: createLogger({ level: "silent" }), now: clock.now, operators: testOperators });
const MARIA = testOperators[0]!.secret;

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set("2026-01-10T12:00:00.000Z");
});
afterAll(async () => {
  await prisma.$disconnect();
});

const richSession = {
  sessionId: "session_123",
  pageUrl: "https://checkout.exemplo.com/produto",
  customFields: { source: "facebook", campaign: "black-friday", content: "criativo-01", affiliateCode: "AFF-001" },
  identifiers: {
    fbclid: "fb-click-id", fbc: "fb.1.1767268000000.AbCdEf", fbp: "fb.1.1767267000000.1234567890",
    gclid: "google-click-id", ttclid: "tiktok-click-id", ttp: "tiktok-cookie",
    redtrackClickId: "redtrack-click-id", utmifyId: "utmify-id",
  },
  customer: { email: "cliente@email.com", phone: "+5511999999999" },
};

const postSession = (body: unknown = richSession) => request(app).post("/tracking/sessions").send(body as object);
const postOrder = (body: unknown = orderPaid()) => request(app).post("/webhooks/orders").send(body as object);
const reprocess = (body: unknown = {}, orderId = "ORD-001", key: string = MARIA) =>
  request(app).post(`/support/orders/${orderId}/reprocess`).set("X-API-Key", key).send(body as object);

async function seed(options: TestKitOptions = {}): Promise<TestKit> {
  const kit = createTestKit(prisma, clock, options);
  await postSession();
  clock.advance(60_000);
  await postOrder();
  await kit.runner.runOnce();
  return kit;
}

const conversions = async () => {
  const rows = await prisma.conversion.findMany({ include: { attempts: { orderBy: { attemptNumber: "asc" } } } });
  return Object.fromEntries(rows.map((r) => [r.provider, r])) as Record<ProviderName, (typeof rows)[number]>;
};
const actionOf = (body: any, provider: string) => body.conversions.find((c: any) => c.target === provider);
const sent = (kit: TestKit) => PROVIDER_NAMES.map((n) => kit.simulators[n].requests.length);

/** Esgota as tentativas do TikTok (limite de 2) com falhas transitórias. */
async function exhaustTikTok(kit: TestKit) {
  kit.simulators.TIKTOK.failNext(99, { status: 503 });
  for (let i = 0; i < 6; i++) {
    await drain(kit.runner);
    clock.advance(3_600_000);
  }
}

describe("POST /support/orders/:orderId/reprocess: registro e validação", () => {
  it("registra data, operador e opções, e responde 202 com o que foi feito", async () => {
    const kit = await seed();
    await drain(kit.runner);
    clock.advance(5000);
    const res = await reprocess({ includePermanentFailures: false });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      orderId: "ORD-001", requestedBy: "maria", includePermanentFailures: false, requestedAt: clock.now().toISOString(),
    });
    const row = await prisma.reprocessRequest.findFirstOrThrow();
    expect(row).toMatchObject({ orderId: "ORD-001", requestedBy: "maria", includePermanentFailures: false });
    expect(row.requestedAt).toEqual(clock.now());
    expect(row.summary).toEqual({ events: expect.any(Array), conversions: expect.any(Array) });
  });

  it("aceita corpo vazio e assume includePermanentFailures = false", async () => {
    await seed();
    const res = await request(app).post("/support/orders/ORD-001/reprocess").set("X-API-Key", MARIA);
    expect(res.status).toBe(202);
    expect(res.body.includePermanentFailures).toBe(false);
  });

  it("responde 400 para opção inválida, sem registrar nada", async () => {
    await seed();
    const res = await reprocess({ includePermanentFailures: "sim" });
    expect(res.status).toBe(400);
    expect(await prisma.reprocessRequest.count()).toBe(0);
  });

  it("responde 404 para pedido sem nenhum evento, sem registrar nada", async () => {
    const res = await reprocess({}, "NAO-EXISTE");
    expect(res.status).toBe(404);
    expect(await prisma.reprocessRequest.count()).toBe(0);
  });

  it("o histórico aparece no endpoint de tracking", async () => {
    const kit = await seed();
    await drain(kit.runner);
    await reprocess();
    const body = (await request(app).get("/support/orders/ORD-001/tracking").set("X-API-Key", MARIA)).body;
    expect(body.reprocessRequests).toEqual([
      expect.objectContaining({ requestedBy: "maria", includePermanentFailures: false, summary: expect.any(Object) }),
    ]);
  });
});

describe("caso 6: reprocessar sem repetir conversões entregues", () => {
  it("tudo entregue: nada a fazer, nenhum envio novo, nenhum job novo", async () => {
    const kit = await seed();
    await drain(kit.runner);
    const before = sent(kit);
    const jobsBefore = await prisma.job.count();

    const res = await reprocess({ includePermanentFailures: true });
    await drain(kit.runner);

    for (const name of PROVIDER_NAMES) expect(actionOf(res.body, name)).toMatchObject({ action: "NOTHING_TO_DO", reason: "DELIVERED" });
    expect(sent(kit)).toEqual(before);
    expect(await prisma.job.count()).toBe(jobsBefore);
    expect(await prisma.conversion.count()).toBe(5);
  });

  it("conversões SKIPPED continuam como estão", async () => {
    const kit = createTestKit(prisma, clock);
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 100, currency: "USD" });
    await drain(kit.runner);
    const res = await reprocess({ includePermanentFailures: true });
    for (const name of PROVIDER_NAMES) expect(actionOf(res.body, name)).toMatchObject({ action: "NOTHING_TO_DO", reason: "SKIPPED" });
    expect(await prisma.job.count({ where: { type: DELIVER_CONVERSION } })).toBe(0);
  });

  it("a atribuição e o payload não mudam: o snapshot e o evento congelado são reaproveitados", async () => {
    const kit = await seed({ conversionMaxAttempts: 2 });
    await exhaustTikTok(kit);
    const snapshotBefore = await prisma.attributionSnapshot.findFirstOrThrow();
    const firstPayload = (await conversions()).TIKTOK.attempts[0]!.requestPayload;

    // A sessão muda depois da criação da conversão.
    await prisma.trackingSession.update({ where: { sessionId: "session_123" }, data: { customerPhone: "+5511888888888", ttclid: "outro-ttclid" } });
    kit.simulators.TIKTOK.reset();
    await reprocess({ includePermanentFailures: true });
    await drain(kit.runner);

    const tiktok = (await conversions()).TIKTOK;
    expect(tiktok.status).toBe("DELIVERED");
    expect(tiktok.attempts.at(-1)!.requestPayload).toEqual(firstPayload);
    expect(JSON.stringify(tiktok.attempts.at(-1)!.requestPayload)).not.toContain("outro-ttclid");
    expect(await prisma.attributionSnapshot.findFirstOrThrow()).toEqual(snapshotBefore);
    expect(await prisma.order.count()).toBe(1);
  });
});

describe("falhas permanentes: só com pedido explícito (ADR-010)", () => {
  it("sem o pedido explícito, uma falha permanente NÃO é reenviada", async () => {
    const kit = await seed({ conversionMaxAttempts: 2 });
    await exhaustTikTok(kit);
    kit.simulators.TIKTOK.reset();
    const jobsBefore = await prisma.job.count();

    const res = await reprocess({});
    await drain(kit.runner);

    expect(actionOf(res.body, "TIKTOK")).toMatchObject({ action: "NOT_RETRIED_PERMANENT_FAILURE", reason: "RETRIES_EXHAUSTED" });
    expect(await prisma.job.count()).toBe(jobsBefore);
    expect(kit.simulators.TIKTOK.requests).toHaveLength(0);
    expect((await conversions()).TIKTOK).toMatchObject({ status: "FAILED_PERMANENT", failureReason: "RETRIES_EXHAUSTED" });
  });

  it("com o pedido explícito, reinicia e entrega: o histórico é preservado e a numeração continua", async () => {
    const kit = await seed({ conversionMaxAttempts: 2 });
    await exhaustTikTok(kit);
    kit.simulators.TIKTOK.reset();

    const res = await reprocess({ includePermanentFailures: true });
    expect(actionOf(res.body, "TIKTOK")).toMatchObject({ action: "RESET_AND_ENQUEUED", reason: "RETRIES_EXHAUSTED" });
    expect((await conversions()).TIKTOK).toMatchObject({ status: "PENDING", failureReason: null, attemptBudgetBase: 2, attemptCount: 2 });

    await drain(kit.runner);
    const tiktok = (await conversions()).TIKTOK;
    expect(tiktok).toMatchObject({ status: "DELIVERED", attemptCount: 3 });
    expect(tiktok.attempts.map((a) => [a.attemptNumber, a.status])).toEqual([[1, "TRANSIENT_FAILURE"], [2, "TRANSIENT_FAILURE"], [3, "SUCCESS"]]);
    expect(kit.simulators.TIKTOK.requests).toHaveLength(1);
  });

  it("o reinício dá um orçamento NOVO de tentativas (o limite conta a partir do reinício)", async () => {
    const kit = await seed({ conversionMaxAttempts: 2 });
    await exhaustTikTok(kit);
    expect((await conversions()).TIKTOK.attemptCount).toBe(2);

    // O provedor continua falhando depois do reinício.
    kit.simulators.TIKTOK.reset();
    kit.simulators.TIKTOK.failNext(99, { status: 503 });
    await reprocess({ includePermanentFailures: true });
    for (let i = 0; i < 6; i++) {
      await drain(kit.runner);
      clock.advance(3_600_000);
    }

    const tiktok = (await conversions()).TIKTOK;
    // Mais exatamente 2 tentativas (3 e 4), e não infinitas nem zero.
    expect(tiktok).toMatchObject({ status: "FAILED_PERMANENT", failureReason: "RETRIES_EXHAUSTED", attemptCount: 4, attemptBudgetBase: 2 });
    expect(kit.simulators.TIKTOK.requests).toHaveLength(2);
    expect(tiktok.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4]);
  });

  it("uma rejeição do provedor (400) também pode ser reenviada depois, com o pedido explícito", async () => {
    const kit = await seed();
    kit.simulators.META.failNext(1, { status: 400 });
    await drain(kit.runner);
    expect((await conversions()).META.failureReason).toBe("PROVIDER_REJECTED:400");

    expect(actionOf((await reprocess({})).body, "META").action).toBe("NOT_RETRIED_PERMANENT_FAILURE");
    expect(actionOf((await reprocess({ includePermanentFailures: true })).body, "META").action).toBe("RESET_AND_ENQUEUED");
    await drain(kit.runner);
    expect((await conversions()).META).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
  });

  it("falhas que repetir não resolve (EVENT_TOO_OLD, CONTRACT_ERROR) não são reiniciadas, nem com o pedido explícito", async () => {
    const kit = await seed();
    kit.simulators.META.failNext(1, { status: 503 });
    await drain(kit.runner);
    clock.advance(8 * 86_400_000);
    await drain(kit.runner);
    expect((await conversions()).META).toMatchObject({ status: "FAILED_PERMANENT", failureReason: "EVENT_TOO_OLD" });

    const row = await prisma.conversion.findFirstOrThrow({ where: { provider: "GOOGLE" } });
    await prisma.conversion.update({ where: { id: row.id }, data: { status: "FAILED_PERMANENT", failureReason: "CONTRACT_ERROR:VALUE_NOT_REPRESENTABLE" } });

    const res = await reprocess({ includePermanentFailures: true });
    expect(actionOf(res.body, "META")).toMatchObject({ action: "NOT_RETRYABLE", reason: "EVENT_TOO_OLD" });
    expect(actionOf(res.body, "GOOGLE")).toMatchObject({ action: "NOT_RETRYABLE", reason: "CONTRACT_ERROR:VALUE_NOT_REPRESENTABLE" });
    expect((await conversions()).META.status).toBe("FAILED_PERMANENT");
    expect((await conversions()).GOOGLE.status).toBe("FAILED_PERMANENT");
  });
});

describe("conversões PENDING e a política de retry", () => {
  it("com retry já agendado: não acelera o backoff e não duplica o job", async () => {
    const kit = await seed();
    kit.simulators.GOOGLE.failNext(1, { status: 503 });
    await drain(kit.runner);
    const google = (await conversions()).GOOGLE;
    const jobBefore = await prisma.job.findFirstOrThrow({ where: { dedupKey: { startsWith: `deliver-conversion:${google.id}` }, status: "PENDING" } });

    const res = await reprocess({ includePermanentFailures: true });
    expect(actionOf(res.body, "GOOGLE")).toEqual({ target: "GOOGLE", action: "ALREADY_SCHEDULED" });

    const jobs = await prisma.job.findMany({ where: { dedupKey: { startsWith: `deliver-conversion:${google.id}` } } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runAt).toEqual(jobBefore.runAt);
    expect(await kit.runner.runOnce()).toBe(false);
  });

  it("com o job de entrega perdido: reenfileira", async () => {
    const kit = await seed();
    const google = (await conversions()).GOOGLE;
    await prisma.job.updateMany({ where: { dedupKey: `deliver-conversion:${google.id}` }, data: { status: "FAILED" } });
    await drain(kit.runner);
    expect((await conversions()).GOOGLE.status).toBe("PENDING");

    const res = await reprocess({});
    expect(actionOf(res.body, "GOOGLE")).toEqual({ target: "GOOGLE", action: "ENQUEUED" });
    await drain(kit.runner);
    expect((await conversions()).GOOGLE).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
    expect(kit.simulators.GOOGLE.requests).toHaveLength(1);
  });
});

describe("pedido que ainda não foi criado", () => {
  it("evento RECEBIDO cujo job se perdeu: reenfileira o processamento e o pedido passa a existir", async () => {
    const kit = createTestKit(prisma, clock);
    await postSession();
    await postOrder();
    await prisma.job.updateMany({ where: { type: "PROCESS_ORDER_EVENT" }, data: { status: "FAILED" } });
    await drain(kit.runner);
    expect(await prisma.order.count()).toBe(0);

    const res = await reprocess({});
    expect(res.status).toBe(202);
    expect(res.body.events).toEqual([{ target: "evt_123", action: "ENQUEUED" }]);
    expect(await prisma.reprocessRequest.findFirstOrThrow()).toMatchObject({ orderId: "ORD-001", orderRefId: null });

    await drain(kit.runner);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.conversion.count()).toBe(5);
  });

  it("evento RECEBIDO com job ainda ativo: não duplica", async () => {
    await postOrder();
    const res = await reprocess({});
    expect(res.body.events).toEqual([{ target: "evt_123", action: "ALREADY_SCHEDULED" }]);
    expect(await prisma.job.count({ where: { type: "PROCESS_ORDER_EVENT" } })).toBe(1);
  });

  it("evento já processado ou ignorado: nada a fazer", async () => {
    const kit = createTestKit(prisma, clock);
    await postSession();
    await postOrder(orderPaid({ eventId: "evt_A" }));
    await postOrder({ eventId: "evt_ref", event: "ORDER_REFUNDED", orderId: "ORD-001" });
    await drain(kit.runner);
    const res = await reprocess({});
    expect(res.body.events).toEqual([
      { target: "evt_A", action: "NOTHING_TO_DO", reason: "PROCESSED" },
      { target: "evt_ref", action: "NOTHING_TO_DO", reason: "IGNORED_UNSUPPORTED" },
    ]);
  });
});

describe("pedidos de reprocessamento simultâneos", () => {
  it("seis pedidos ao mesmo tempo para uma falha permanente: uma única reinicialização e um único job novo", async () => {
    const kit = await seed({ conversionMaxAttempts: 2 });
    await exhaustTikTok(kit);
    kit.simulators.TIKTOK.reset();
    const id = (await conversions()).TIKTOK.id;

    const responses = await Promise.all(Array.from({ length: 6 }, () => reprocess({ includePermanentFailures: true })));
    expect(responses.every((r) => r.status === 202)).toBe(true);

    const actions = responses.map((r) => actionOf(r.body, "TIKTOK").action);
    expect(actions.filter((a) => a === "RESET_AND_ENQUEUED")).toHaveLength(1);
    expect(actions.filter((a) => a === "ALREADY_SCHEDULED")).toHaveLength(5);
    expect(await prisma.job.count({ where: { dedupKey: { startsWith: `deliver-conversion:${id}:reprocess:` } } })).toBe(1);
    expect(await prisma.reprocessRequest.count()).toBe(6);

    await drain(kit.runner);
    expect(kit.simulators.TIKTOK.requests).toHaveLength(1);
    expect((await conversions()).TIKTOK).toMatchObject({ status: "DELIVERED", attemptCount: 3 });
  });
});

describe("lock por pedido, verificado de forma determinística", () => {
  it("o reprocessamento espera enquanto outra transação segura o lock do pedido, e só depois registra o pedido", async () => {
    const kit = await seed();
    await drain(kit.runner);

    let pending: Promise<number> | undefined;
    let requestsWhileLocked = -1;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"reprocess:ORD-001"}, 0))`;
      pending = reprocess({}).then((res) => res.status);
      await new Promise((resolve) => setTimeout(resolve, 600));
      requestsWhileLocked = await prisma.reprocessRequest.count();
    });

    expect(requestsWhileLocked).toBe(0);
    expect(await pending).toBe(202);
    expect(await prisma.reprocessRequest.count()).toBe(1);
  });

  it("o lock de um pedido não bloqueia o reprocessamento de outro", async () => {
    const kit = createTestKit(prisma, clock);
    await postSession();
    await postOrder(orderPaid({ eventId: "evt_other", orderId: "ORD-OTHER" }));
    await drain(kit.runner);

    let status = 0;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"reprocess:ORD-001"}, 0))`;
      status = (await reprocess({}, "ORD-OTHER")).status;
    });
    expect(status).toBe(202);
  });
});
