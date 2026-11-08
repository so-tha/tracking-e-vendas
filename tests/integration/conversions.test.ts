import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { DELIVER_CONVERSION } from "../../src/modules/conversions/create.js";
import { createDeliverConversion } from "../../src/modules/conversions/deliver.js";
import { PROVIDER_NAMES, TransportError, type ProviderName } from "../../src/modules/conversions/types.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma, resetDatabase } from "./helpers/db.js";
import { createClock, createTestKit, drain, orderPaid, testProvidersConfig, type TestKitOptions } from "./helpers/orders.js";

const prisma = createTestPrisma();
const clock = createClock("2026-01-10T12:00:00.000Z");
const app = createApp({ prisma, logger: createLogger({ level: "silent" }), now: clock.now });

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set("2026-01-10T12:00:00.000Z");
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Sessão completa, com identificadores em formatos realistas (a do documento usa placeholders). */
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
const kitWith = (options: TestKitOptions = {}) => createTestKit(prisma, clock, options);

const conversions = async () => {
  const rows = await prisma.conversion.findMany({ include: { attempts: { orderBy: { attemptNumber: "asc" } } } });
  return Object.fromEntries(rows.map((row) => [row.provider, row])) as Record<ProviderName, (typeof rows)[number]>;
};
const deliverJobs = (status?: "PENDING" | "DONE" | "FAILED") =>
  prisma.job.findMany({ where: { type: DELIVER_CONVERSION, ...(status ? { status } : {}) }, orderBy: { createdAt: "asc" } });

/** Cria sessão e pedido atribuído pelo nível 1, e processa só o PROCESS_ORDER_EVENT (as entregas ficam pendentes). */
async function seedPending(kit = kitWith()) {
  await postSession();
  clock.advance(60_000);
  await postOrder();
  await kit.runner.runOnce();
  return kit;
}

describe("criação das conversões", () => {
  it("pedido com tracking completo: 5 conversões PENDING com evento congelado, chave de deduplicação e job de entrega", async () => {
    const kit = await seedPending();
    const rows = await conversions();

    expect(Object.keys(rows).sort()).toEqual([...PROVIDER_NAMES].sort());
    for (const name of PROVIDER_NAMES) {
      expect(rows[name]).toMatchObject({ status: "PENDING", skipReason: null, attemptCount: 0, dedupKey: `ORD-001:${name}:ORDER_PAID` });
      expect(rows[name].eventSnapshot).toMatchObject({ version: 1, orderId: "ORD-001", eventId: "ORD-001", amountDecimal: "255.00" });
      expect(rows[name].attempts).toHaveLength(0);
    }
    expect(await deliverJobs("PENDING")).toHaveLength(5);
    expect(Object.values(kit.simulators).every((s) => s.requests.length === 0)).toBe(true);
  });

  it("uma conversão por pedido e provedor, mesmo repetindo o evento e reexecutando o job do pedido", async () => {
    const kit = kitWith();
    await postSession();
    await postOrder();
    await postOrder();
    await drain(kit.runner);

    await prisma.job.updateMany({ where: { type: "PROCESS_ORDER_EVENT" }, data: { status: "PENDING", attempts: 0, runAt: clock.now() } });
    await drain(kit.runner);

    expect(await prisma.conversion.count()).toBe(5);
    expect(await prisma.deliveryAttempt.count()).toBe(5);
    for (const sim of Object.values(kit.simulators)) expect(sim.accepted).toHaveLength(1);
  });

  it("venda sem tracking: tudo SKIPPED com o motivo, sem DeliveryAttempt, sem job e sem nenhum envio (caso 2)", async () => {
    const kit = kitWith();
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 5000, currency: "BRL" });
    await drain(kit.runner);

    const rows = await conversions();
    expect(rows.META).toMatchObject({ status: "SKIPPED", skipReason: "MISSING_REQUIRED_IDENTIFIER:fbc|fbp" });
    expect(rows.GOOGLE).toMatchObject({ status: "SKIPPED", skipReason: "MISSING_REQUIRED_IDENTIFIER:gclid|gbraid|wbraid" });
    expect(rows.TIKTOK).toMatchObject({ status: "SKIPPED", skipReason: "MISSING_REQUIRED_IDENTIFIER:ttclid|ttp" });
    expect(rows.REDTRACK).toMatchObject({ status: "SKIPPED", skipReason: "MISSING_REQUIRED_IDENTIFIER:redtrackClickId" });
    expect(rows.UTMIFY).toMatchObject({ status: "SKIPPED", skipReason: "MISSING_REQUIRED_FIELD:customer.email" });

    expect(await prisma.deliveryAttempt.count()).toBe(0);
    expect(await deliverJobs()).toHaveLength(0);
    for (const sim of Object.values(kit.simulators)) expect(sim.requests).toHaveLength(0);
  });

  it("elegibilidade por provedor: só os que têm identificador obrigatório são enviados", async () => {
    const kit = kitWith();
    await postSession({ sessionId: "S", pageUrl: "https://a.com", identifiers: { gclid: "g", redtrackClickId: "r" } });
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "O1", sessionId: "S", amount: 100, currency: "USD" });
    await drain(kit.runner);

    const rows = await conversions();
    expect(Object.fromEntries(PROVIDER_NAMES.map((n) => [n, rows[n].status]))).toEqual({
      META: "SKIPPED", GOOGLE: "DELIVERED", TIKTOK: "SKIPPED", UTMIFY: "SKIPPED", REDTRACK: "DELIVERED",
    });
    expect(kit.simulators.META.requests).toHaveLength(0);
    expect(kit.simulators.TIKTOK.requests).toHaveLength(0);
  });

  it("evento com mais de 7 dias no processamento: Meta e UTMify viram SKIPPED por EVENT_TOO_OLD, os demais seguem", async () => {
    const kit = kitWith();
    await postSession();
    await postOrder();
    clock.advance(8 * 86_400_000);
    await drain(kit.runner);

    const rows = await conversions();
    expect(rows.META).toMatchObject({ status: "SKIPPED", skipReason: "EVENT_TOO_OLD" });
    expect(rows.UTMIFY).toMatchObject({ status: "SKIPPED", skipReason: "EVENT_TOO_OLD" });
    expect(rows.GOOGLE.status).toBe("DELIVERED");
    expect(rows.TIKTOK.status).toBe("DELIVERED");
    expect(rows.REDTRACK.status).toBe("DELIVERED");
  });
});

describe("entrega bem-sucedida e auditoria do payload", () => {
  it("entrega os cinco provedores, cada um uma vez, com uma tentativa de sucesso", async () => {
    const kit = await seedPending();
    await drain(kit.runner);

    const rows = await conversions();
    for (const name of PROVIDER_NAMES) {
      expect(rows[name]).toMatchObject({ status: "DELIVERED", attemptCount: 1, failureReason: null });
      expect(rows[name].deliveredAt).toEqual(clock.now());
      expect(rows[name].attempts).toHaveLength(1);
      expect(rows[name].attempts[0]).toMatchObject({ attemptNumber: 1, status: "SUCCESS", httpStatus: 200, error: null });
      expect(kit.simulators[name].accepted).toHaveLength(1);
    }
    expect(await deliverJobs("DONE")).toHaveLength(5);
  });

  it("cada tentativa grava o request efetivamente enviado, idêntico ao que o provedor recebeu", async () => {
    const kit = await seedPending();
    await drain(kit.runner);
    const rows = await conversions();

    for (const name of PROVIDER_NAMES) {
      const stored = rows[name].attempts[0]!.requestPayload as { method: string; url: string; body?: unknown };
      const received = kit.simulators[name].accepted[0]!;
      expect(stored.method).toBe(received.method);
      expect(stored.url).toBe(received.url);
      expect(stored.body).toEqual(received.body);
      expect(rows[name].lastPayload).toEqual(stored);
    }
  });

  it("nenhuma credencial é gravada em lugar nenhum do banco", async () => {
    await drain((await seedPending()).runner);
    const everything = JSON.stringify({
      attempts: await prisma.deliveryAttempt.findMany(),
      conversions: await prisma.conversion.findMany(),
    });
    expect(everything).not.toContain("SEGREDO");
    for (const token of Object.values(testProvidersConfig).flatMap((c) => Object.values(c)).filter((v) => String(v).startsWith("SEGREDO"))) {
      expect(everything).not.toContain(String(token));
    }
  });

  it("Meta, Google e TikTok só recebem e-mail e telefone com hash. A UTMify recebe em claro, por exigência do contrato", async () => {
    const kit = await seedPending();
    await drain(kit.runner);
    const rows = await conversions();
    const payload = (name: ProviderName) => JSON.stringify(rows[name].attempts[0]!.requestPayload);

    for (const name of ["META", "GOOGLE", "TIKTOK"] as const) {
      expect(payload(name)).not.toContain("cliente@email.com");
      expect(payload(name)).not.toContain("5511999999999");
    }
    expect(payload("REDTRACK")).not.toContain("cliente");
    expect(payload("UTMIFY")).toContain("cliente@email.com");
  });

  it("valor decimal exato em cada contrato: 255 (Meta, Google, TikTok), '255.00' (RedTrack), 25500 centavos (UTMify)", async () => {
    const kit = await seedPending();
    await drain(kit.runner);
    const body = (name: ProviderName) => kit.simulators[name].accepted[0]!.body as any;

    expect(body("META").data[0].custom_data.value).toBe(255);
    expect(body("GOOGLE").events[0].conversionValue).toBe(255);
    expect(body("TIKTOK").data[0].properties.value).toBe(255);
    expect(new URL(kit.simulators.REDTRACK.accepted[0]!.fullUrl).searchParams.get("sum")).toBe("255.00");
    expect(body("UTMIFY").products[0].priceInCents).toBe(25500);
  });
});

describe("afiliado restrito aos níveis 1 a 3 (ADR-018)", () => {
  const metaBody = (kit: ReturnType<typeof kitWith>) => kit.simulators.META.accepted[0]!.body as any;

  it("nível 1 (sessionId): o afiliado vai no payload da Meta", async () => {
    const kit = await seedPending();
    await drain(kit.runner);
    expect(metaBody(kit).data[0].custom_data.affiliate_code).toBe("AFF-001");
  });

  it("nível 3 (click ID): o afiliado também vai", async () => {
    const kit = kitWith();
    await postSession();
    await postOrder(orderPaid({ sessionId: undefined, identifiers: { gclid: "google-click-id" } }));
    await drain(kit.runner);
    const snapshot = await prisma.attributionSnapshot.findFirstOrThrow();
    expect(snapshot).toMatchObject({ level: 3, affiliateEvidenceLevel: 3 });
    expect(metaBody(kit).data[0].custom_data.affiliate_code).toBe("AFF-001");
  });

  it("nível 4 (cliente + janela): o afiliado fica no snapshot, mas NÃO vai a nenhum provedor", async () => {
    const kit = kitWith();
    await postSession();
    await postOrder(orderPaid({ sessionId: undefined }));
    await drain(kit.runner);

    const snapshot = await prisma.attributionSnapshot.findFirstOrThrow();
    expect(snapshot).toMatchObject({ level: 4, affiliateCode: "AFF-001", affiliateEvidenceLevel: 4 });
    expect((await conversions()).META.status).toBe("DELIVERED");
    expect(JSON.stringify(metaBody(kit))).not.toContain("AFF-001");
    for (const name of PROVIDER_NAMES) {
      expect(JSON.stringify(kit.simulators[name].accepted.map((r) => r.body))).not.toContain("AFF-001");
    }
  });

  it("venda não atribuída: o afiliado do webhook não vai a nenhum provedor", async () => {
    const kit = kitWith();
    await postOrder(orderPaid({ sessionId: undefined, identifiers: { ttclid: "tt-1", redtrackClickId: "rt-1" } }));
    await drain(kit.runner);

    expect((await prisma.attributionSnapshot.findFirstOrThrow()).result).toBe("UNATTRIBUTED");
    expect((await conversions()).TIKTOK.status).toBe("DELIVERED");
    for (const name of PROVIDER_NAMES) {
      expect(JSON.stringify(kit.simulators[name].requests.map((r) => r.body ?? r.url))).not.toContain("AFF-001");
    }
  });
});

describe("caso 5: falha temporária com retry e falha isolada entre provedores", () => {
  it("o Google falha com 503: ele tenta de novo com backoff e os outros quatro entregam normalmente", async () => {
    const kit = await seedPending();
    kit.simulators.GOOGLE.failNext(1, { status: 503 });
    await drain(kit.runner);

    let rows = await conversions();
    expect(rows.GOOGLE).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect(rows.GOOGLE.attempts).toHaveLength(1);
    expect(rows.GOOGLE.attempts[0]).toMatchObject({ status: "TRANSIENT_FAILURE", httpStatus: 503, attemptNumber: 1 });
    for (const name of ["META", "TIKTOK", "UTMIFY", "REDTRACK"] as const) expect(rows[name].status).toBe("DELIVERED");

    // O job do Google foi reagendado para o futuro (backoff de 1s na 1ª falha).
    const pending = await deliverJobs("PENDING");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.runAt).toEqual(new Date(clock.now().getTime() + 1000));
    expect(await kit.runner.runOnce()).toBe(false);

    clock.advance(1000);
    await drain(kit.runner);
    rows = await conversions();
    expect(rows.GOOGLE).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
    expect(rows.GOOGLE.attempts.map((a) => [a.attemptNumber, a.status])).toEqual([[1, "TRANSIENT_FAILURE"], [2, "SUCCESS"]]);

    // Os outros provedores receberam exatamente uma vez. A falha do Google não os repetiu.
    for (const name of ["META", "TIKTOK", "UTMIFY", "REDTRACK"] as const) expect(kit.simulators[name].requests).toHaveLength(1);
    expect(kit.simulators.GOOGLE.requests).toHaveLength(2);
  });

  it("o backoff dobra a cada falha e o Retry-After do provedor é respeitado quando maior", async () => {
    const kit = await seedPending();
    kit.simulators.TIKTOK.failNext(3, { status: 503 });
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      await drain(kit.runner);
      const job = (await deliverJobs("PENDING"))[0]!;
      delays.push(job.runAt.getTime() - clock.now().getTime());
      clock.advance(delays[i]!);
    }
    expect(delays).toEqual([1000, 2000, 4000]);
    await drain(kit.runner);
    expect((await conversions()).TIKTOK.status).toBe("DELIVERED");

    // Retry-After de 30s vence o backoff de 1s.
    await resetDatabase(prisma);
    clock.set("2026-01-10T12:00:00.000Z");
    const kit2 = await seedPending();
    kit2.simulators.REDTRACK.failNext(1, { status: 429, headers: { "Retry-After": "30" } });
    await drain(kit2.runner);
    const job = (await deliverJobs("PENDING"))[0]!;
    expect(job.runAt.getTime() - clock.now().getTime()).toBe(30_000);
  });

  it("falha de rede (timeout) é transitória: grava o erro sem status HTTP e tenta de novo", async () => {
    const kit = await seedPending();
    kit.simulators.META.failNext(1, { throws: new TransportError("timeout", "sem resposta em 10s") });
    await drain(kit.runner);
    const rows = await conversions();
    expect(rows.META.attempts[0]).toMatchObject({ status: "TRANSIENT_FAILURE", httpStatus: null, error: "timeout: sem resposta em 10s" });
    expect(rows.META.status).toBe("PENDING");
  });

  it("tentativas esgotadas: FAILED_PERMANENT com RETRIES_EXHAUSTED, sem novo job e sem novos envios (sem loop)", async () => {
    const kit = await seedPending(kitWith({ conversionMaxAttempts: 3 }));
    kit.simulators.TIKTOK.failNext(99, { status: 503 });
    for (let i = 0; i < 10; i++) {
      await drain(kit.runner);
      clock.advance(3_600_000);
    }

    const row = (await conversions()).TIKTOK;
    expect(row).toMatchObject({ status: "FAILED_PERMANENT", failureReason: "RETRIES_EXHAUSTED", attemptCount: 3 });
    expect(row.attempts.map((a) => [a.attemptNumber, a.status])).toEqual([[1, "TRANSIENT_FAILURE"], [2, "TRANSIENT_FAILURE"], [3, "TRANSIENT_FAILURE"]]);
    expect(kit.simulators.TIKTOK.requests).toHaveLength(3);
    expect(await deliverJobs("PENDING")).toHaveLength(0);
  });

  it("erro permanente (400): uma única tentativa, FAILED_PERMANENT, sem retry, mesmo com o tempo passando", async () => {
    const kit = await seedPending();
    kit.simulators.META.failNext(1, { status: 400, body: { error: { message: "invalid" } } });
    await drain(kit.runner);
    clock.advance(30 * 86_400_000);
    await drain(kit.runner);

    const row = (await conversions()).META;
    expect(row).toMatchObject({ status: "FAILED_PERMANENT", failureReason: "PROVIDER_REJECTED:400", attemptCount: 1 });
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]).toMatchObject({ status: "PERMANENT_FAILURE", httpStatus: 400 });
    expect(row.attempts[0]!.responseBody).toEqual({ error: { message: "invalid" } });
    expect(kit.simulators.META.requests).toHaveLength(1);
    expect((await deliverJobs("DONE")).length).toBe(5);
  });

  it("401 (credencial) também é permanente. 403 idem", async () => {
    for (const status of [401, 403]) {
      await resetDatabase(prisma);
      clock.set("2026-01-10T12:00:00.000Z");
      const kit = await seedPending();
      kit.simulators.GOOGLE.failNext(1, { status });
      await drain(kit.runner);
      expect((await conversions()).GOOGLE).toMatchObject({ status: "FAILED_PERMANENT", failureReason: `PROVIDER_REJECTED:${status}`, attemptCount: 1 });
    }
  });

  it("TikTok com HTTP 200 e code diferente de 0 é permanente e não repete", async () => {
    const kit = await seedPending();
    kit.simulators.TIKTOK.failNext(1, { status: 200, body: { code: 40002, message: "invalid" } });
    await drain(kit.runner);
    expect((await conversions()).TIKTOK).toMatchObject({ status: "FAILED_PERMANENT", failureReason: "PROVIDER_REJECTED:200", attemptCount: 1 });
  });

  it("TikTok com code 40100 (limite de requisições): não perde a conversão, espera 5 minutos e entrega", async () => {
    const kit = await seedPending();
    kit.simulators.TIKTOK.failNext(1, { status: 200, body: { code: 40100, message: "Too many requests" } });
    await drain(kit.runner);

    let tiktok = (await conversions()).TIKTOK;
    expect(tiktok).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect(tiktok.attempts[0]).toMatchObject({ status: "TRANSIENT_FAILURE", httpStatus: 200 });
    const job = (await deliverJobs("PENDING"))[0]!;
    expect(job.runAt.getTime() - clock.now().getTime()).toBe(300_000);

    clock.advance(300_000);
    await drain(kit.runner);
    tiktok = (await conversions()).TIKTOK;
    expect(tiktok).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
  });

  it("isolamento total: cada provedor falha de um jeito diferente e nenhum afeta o outro", async () => {
    const kit = await seedPending();
    kit.simulators.META.failNext(1, { status: 503 });
    kit.simulators.GOOGLE.failNext(1, { status: 400 });
    kit.simulators.TIKTOK.failNext(1, { throws: new TransportError("network", "ECONNRESET") });
    kit.simulators.UTMIFY.failNext(1, { status: 429, headers: { "Retry-After": "5" } });
    await drain(kit.runner);

    let rows = await conversions();
    expect(Object.fromEntries(PROVIDER_NAMES.map((n) => [n, rows[n].status]))).toEqual({
      META: "PENDING", GOOGLE: "FAILED_PERMANENT", TIKTOK: "PENDING", UTMIFY: "PENDING", REDTRACK: "DELIVERED",
    });

    clock.advance(10_000);
    await drain(kit.runner);
    rows = await conversions();
    expect(Object.fromEntries(PROVIDER_NAMES.map((n) => [n, rows[n].status]))).toEqual({
      META: "DELIVERED", GOOGLE: "FAILED_PERMANENT", TIKTOK: "DELIVERED", UTMIFY: "DELIVERED", REDTRACK: "DELIVERED",
    });
    expect(kit.simulators.REDTRACK.requests).toHaveLength(1);
  });

  it("um bug inesperado em um adaptador fica isolado: vira falha transitória, e os outros entregam", async () => {
    const kit = await seedPending();
    const original = kit.registry.GOOGLE;
    kit.registry.GOOGLE = { ...original, send: async () => { throw new TypeError("bug no adaptador"); } };
    await drain(kit.runner);

    const rows = await conversions();
    expect(rows.GOOGLE).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect(rows.GOOGLE.attempts[0]).toMatchObject({ status: "TRANSIENT_FAILURE", httpStatus: null });
    expect(rows.GOOGLE.attempts[0]!.error).toContain("UNEXPECTED_ADAPTER_ERROR: bug no adaptador");
    expect(JSON.stringify(rows.GOOGLE.attempts[0]!.requestPayload)).not.toContain("SEGREDO");
    for (const name of ["META", "TIKTOK", "UTMIFY", "REDTRACK"] as const) expect(rows[name].status).toBe("DELIVERED");
  });
});

describe("idade do evento durante a entrega (Meta e UTMify, 7 dias)", () => {
  it("conversão que nunca foi tentada e envelheceu antes da entrega vira SKIPPED, sem tentativa", async () => {
    const kit = await seedPending();
    clock.advance(8 * 86_400_000);
    await drain(kit.runner);

    const rows = await conversions();
    for (const name of ["META", "UTMIFY"] as const) {
      expect(rows[name]).toMatchObject({ status: "SKIPPED", skipReason: "EVENT_TOO_OLD", attemptCount: 0 });
      expect(rows[name].attempts).toHaveLength(0);
      expect(kit.simulators[name].requests).toHaveLength(0);
    }
    expect(rows.GOOGLE.status).toBe("DELIVERED");
  });

  it("conversão já tentada que envelheceu durante os retries vira FAILED_PERMANENT, sem nova tentativa", async () => {
    const kit = await seedPending();
    kit.simulators.META.failNext(1, { status: 503 });
    await drain(kit.runner);
    clock.advance(8 * 86_400_000);
    await drain(kit.runner);

    const row = (await conversions()).META;
    expect(row).toMatchObject({ status: "FAILED_PERMANENT", failureReason: "EVENT_TOO_OLD", attemptCount: 1 });
    expect(row.attempts).toHaveLength(1);
    expect(kit.simulators.META.requests).toHaveLength(1);
  });
});

describe("caso 6: reprocessamento sem repetir conversões entregues", () => {
  const totals = (kit: ReturnType<typeof kitWith>) => PROVIDER_NAMES.map((n) => kit.simulators[n].requests.length);

  it("reexecutar todos os jobs não reenvia nenhuma conversão já entregue", async () => {
    const kit = await seedPending();
    await drain(kit.runner);
    const before = await conversions();
    const sent = totals(kit);

    await prisma.job.updateMany({ data: { status: "PENDING", attempts: 0, runAt: clock.now() } });
    await drain(kit.runner);

    expect(totals(kit)).toEqual(sent);
    expect(totals(kit)).toEqual([1, 1, 1, 1, 1]);
    const after = await conversions();
    for (const name of PROVIDER_NAMES) {
      expect(after[name].status).toBe("DELIVERED");
      expect(after[name].attempts).toHaveLength(1);
      expect(after[name].deliveredAt).toEqual(before[name].deliveredAt);
    }
    expect(await prisma.conversion.count()).toBe(5);
  });

  it("reexecutar os jobs também não retenta uma falha permanente (isso exige solicitação explícita)", async () => {
    const kit = await seedPending();
    kit.simulators.GOOGLE.failNext(1, { status: 400 });
    await drain(kit.runner);
    const sent = totals(kit);

    await prisma.job.updateMany({ data: { status: "PENDING", attempts: 0, runAt: clock.now() } });
    await drain(kit.runner);

    expect(totals(kit)).toEqual(sent);
    expect((await conversions()).GOOGLE).toMatchObject({ status: "FAILED_PERMANENT", attemptCount: 1 });
  });

  it("o payload da nova tentativa é idêntico ao da primeira, mesmo que a sessão mude no meio (evento congelado)", async () => {
    const kit = await seedPending();
    kit.simulators.GOOGLE.failNext(1, { status: 503 });
    await drain(kit.runner);

    // A sessão recebe dados diferentes depois da criação da conversão.
    await prisma.trackingSession.update({
      where: { sessionId: "session_123" },
      data: { customerPhone: "+5511888888888", gclid: "outro-gclid" },
    });
    clock.advance(1000);
    await drain(kit.runner);

    const attempts = (await conversions()).GOOGLE.attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.requestPayload).toEqual(attempts[0]!.requestPayload);
    expect(JSON.stringify(attempts[1]!.requestPayload)).not.toContain("outro-gclid");
  });
});

describe("execuções simultâneas do mesmo job (reaproveitamento de job abandonado)", () => {
  it("duas execuções concorrentes gravam uma única tentativa e a conversão fica consistente", async () => {
    const kit = await seedPending();
    const handler = createDeliverConversion(prisma, clock.now, { providers: kit.registry, maxAttempts: 4, retryBaseMs: 1000 });
    const job = (await deliverJobs())[0]!;
    const claimed = { id: job.id, type: job.type, payload: job.payload, dedupKey: job.dedupKey, attempts: 1 };

    await Promise.all([handler(claimed), handler(claimed), handler(claimed)]);

    const conversionId = (job.payload as { conversionId: string }).conversionId;
    const row = await prisma.conversion.findUniqueOrThrow({ where: { id: conversionId }, include: { attempts: true } });
    expect(row.status).toBe("DELIVERED");
    expect(row.attemptCount).toBe(1);
    expect(row.attempts).toHaveLength(1);
  });

  it("o RedTrack absorve o reenvio pela chave rdtk_event_id: duas chamadas, uma conversão", async () => {
    const kit = await seedPending();
    const handler = createDeliverConversion(prisma, clock.now, { providers: kit.registry, maxAttempts: 4, retryBaseMs: 1000 });
    const conversion = await prisma.conversion.findFirstOrThrow({ where: { provider: "REDTRACK" } });
    const job = await prisma.job.findFirstOrThrow({ where: { dedupKey: `deliver-conversion:${conversion.id}` } });
    const claimed = { id: job.id, type: job.type, payload: job.payload, dedupKey: job.dedupKey, attempts: 1 };

    await Promise.all([handler(claimed), handler(claimed)]);
    expect(kit.simulators.REDTRACK.recorded).toHaveLength(1);
  });
});

describe("atribuição e conversão continuam separadas (ADR-009)", () => {
  it("o snapshot não muda quando as conversões são entregues, falham ou são retentadas", async () => {
    const kit = await seedPending();
    const before = await prisma.attributionSnapshot.findFirstOrThrow();
    kit.simulators.GOOGLE.failNext(1, { status: 503 });
    await drain(kit.runner);
    clock.advance(5000);
    await drain(kit.runner);
    expect(await prisma.attributionSnapshot.findFirstOrThrow()).toEqual(before);
  });
});
