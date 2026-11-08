import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { sha256Hex } from "../../src/shared/pii.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma, resetDatabase } from "./helpers/db.js";
import { createClock, createTestKit, drain, orderPaid, testOperators, type TestKit } from "./helpers/orders.js";

const prisma = createTestPrisma();
const clock = createClock("2026-01-10T12:00:00.000Z");
const logger = createLogger({ level: "silent" });
const app = createApp({ prisma, logger, now: clock.now, operators: testOperators });
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
/** `key = null` significa "sem o cabeçalho". (undefined ativaria o valor padrão, e foi um erro anterior meu.) */
const view = (orderId = "ORD-001", key: string | null = MARIA) => {
  const req = request(app).get(`/support/orders/${orderId}/tracking`);
  return key === null ? req : req.set("X-API-Key", key);
};
const conversion = (body: any, provider: string) => body.conversions.find((c: any) => c.provider === provider);

/** Nenhum dado pessoal em claro, segredo ou dado interno pode sair do endpoint de suporte. */
function assertNoLeak(body: unknown) {
  const text = JSON.stringify(body);
  for (const forbidden of ["cliente@email.com", "dupla@email.com", "5511999999999", "SEGREDO", "eventSnapshot", "dedupKey"]) {
    expect(text, `vazou: ${forbidden}`).not.toContain(forbidden);
  }
}

async function seed(kit: TestKit, session: unknown = richSession, order: unknown = orderPaid()) {
  await postSession(session);
  clock.advance(60_000);
  await postOrder(order);
  await kit.runner.runOnce();
}

describe("autenticação de /support (ADR-024)", () => {
  it.each([
    ["sem a chave", null],
    ["com chave errada", "chave-errada"],
    ["com prefixo da chave", MARIA.slice(0, 10)],
    ["com chave vazia", ""],
  ])("responde 401 %s, sem dar pistas", async (_name, key) => {
    const res = await view("ORD-001", key);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("com chave válida a autenticação passa (404 mostra que chegou ao handler)", async () => {
    expect((await view("NAO-EXISTE")).status).toBe(404);
    expect((await view("NAO-EXISTE", testOperators[1]!.secret)).status).toBe(404);
  });

  it("o reprocessamento também exige chave e não grava nada sem ela", async () => {
    const res = await request(app).post("/support/orders/ORD-001/reprocess").send({});
    expect(res.status).toBe(401);
    expect(await prisma.reprocessRequest.count()).toBe(0);
  });

  it("sem operadores configurados, todo acesso a /support é negado", async () => {
    const closed = createApp({ prisma, logger, now: clock.now });
    expect((await request(closed).get("/support/orders/X/tracking").set("X-API-Key", MARIA)).status).toBe(401);
    expect((await request(closed).get("/support/orders/X/tracking")).status).toBe(401);
  });

  it("não protege (nem quebra) as rotas públicas de tracking e webhook", async () => {
    expect((await postSession()).status).toBe(201);
    expect((await postOrder()).status).toBe(202);
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("o operador registrado vem da configuração da chave, e não de campos enviados pelo cliente", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit);
    await request(app)
      .post("/support/orders/ORD-001/reprocess")
      .set("X-API-Key", testOperators[1]!.secret)
      .set("X-Requested-By", "maria")
      .set("X-Operator", "maria")
      .send({ requestedBy: "maria", operator: "maria", includePermanentFailures: false });

    const row = await prisma.reprocessRequest.findFirstOrThrow();
    expect(row.requestedBy).toBe("joao");
  });
});

describe("GET /support/orders/:orderId/tracking: venda atribuída e entregue", () => {
  it("responde à pergunta real: qual valor foi associado, de onde veio e exatamente o que foi enviado", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit);
    await drain(kit.runner);

    const res = await view();
    expect(res.status).toBe(200);
    const body = res.body;

    // Que valor foi associado ao RedTrack e de onde veio.
    expect(conversion(body, "REDTRACK").identifiers).toEqual([
      { field: "redtrackClickId", value: "redtrack-click-id", source: "SESSION" },
    ]);
    // Exatamente o que foi enviado.
    expect(conversion(body, "REDTRACK").sentPayload).toEqual({
      method: "GET",
      url: "https://track.exemplo.com/postback?clickid=redtrack-click-id&sum=255.00&type=Purchase&rdtk_event_id=ORD-001",
    });
    assertNoLeak(body);
  });

  it("descreve o pedido, a sessão e a atribuição, com a origem de cada informação", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit);
    await drain(kit.runner);
    const body = (await view()).body;

    expect(body.order).toEqual({
      amountMinor: "25500", currency: "USD", amountDecimal: "255.00",
      receivedAt: "2026-01-10T12:01:00.000Z", customerEmail: "c***@email.com", webhookSessionId: "session_123",
    });
    expect(body.attribution).toMatchObject({ result: "ATTRIBUTED", level: 1, method: "SESSION_ID", unattributedReason: null, alerts: [] });
    expect(body.attribution.explanation).toContain("sessionId");
    expect(body.attribution.session).toMatchObject({ sessionId: "session_123", pageUrl: "https://checkout.exemplo.com/produto", revisions: 1, conflicts: [] });
    expect(body.attribution.decisionTrace[0]).toMatchObject({ step: "LEVEL_1_SESSION_ID", outcome: "FOUND" });

    expect(body.trackingData.customFields).toEqual({ value: richSession.customFields, source: "WEBHOOK" });
    expect(body.trackingData.identifiers.fbc).toEqual({ value: "fb.1.1767268000000.AbCdEf", source: "SESSION" });
    expect(body.trackingData.affiliate).toMatchObject({ code: "AFF-001", source: "WEBHOOK", evidenceLevel: 1, sentToProviders: true });
    expect(body.events).toEqual([expect.objectContaining({ eventId: "evt_123", status: "PROCESSED", eventType: "ORDER_PAID" })]);
  });

  it("lista as cinco conversões em ordem fixa, com tentativas, status e o request enviado a cada uma", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit);
    await drain(kit.runner);
    const body = (await view()).body;

    expect(body.conversions.map((c: any) => c.provider)).toEqual(["META", "GOOGLE", "TIKTOK", "UTMIFY", "REDTRACK"]);
    for (const c of body.conversions) {
      expect(c).toMatchObject({ status: "DELIVERED", attemptCount: 1, nextAttemptAt: null, skipReason: null, failureReason: null });
      expect(c.explanation).toBe("Entregue ao provedor na tentativa 1.");
      expect(c.attempts).toHaveLength(1);
      expect(c.attempts[0]).toMatchObject({ attemptNumber: 1, status: "SUCCESS", httpStatus: 200 });
      expect(c.attempts[0].request.url).toBeTypeOf("string");
    }
    expect(conversion(body, "META").identifiers).toEqual([
      { field: "fbc", value: "fb.1.1767268000000.AbCdEf", source: "SESSION" },
      { field: "fbp", value: "fb.1.1767267000000.1234567890", source: "SESSION" },
    ]);
  });

  it("mostra o hash enviado à Meta, mas mascara o e-mail e o telefone em claro da UTMify (ADR-019)", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit);
    await drain(kit.runner);
    const body = (await view()).body;

    const meta = conversion(body, "META").attempts[0].request.body.data[0].user_data;
    expect(meta.em).toEqual([sha256Hex("cliente@email.com")]);

    const utmify = conversion(body, "UTMIFY").attempts[0].request.body.customer;
    expect(utmify.email).toBe("c***@email.com");
    expect(utmify.phone).toBe("*********9999"); // a UTMify recebe só os 13 dígitos, sem o +
    expect(utmify.name).toBe("C***");
  });

  it("não devolve o payload bruto do webhook nem o evento congelado", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit, richSession, orderPaid({ campoSecretoDoPayload: "VALOR-INTERNO" }));
    await drain(kit.runner);
    const text = JSON.stringify((await view()).body);
    expect(text).not.toContain("VALOR-INTERNO");
    expect(text).not.toContain("campoSecretoDoPayload");
  });
});

describe("GET /support/orders/:orderId/tracking: por que não foi enviada ou não foi atribuída", () => {
  it("venda sem tracking: explica a não atribuição e cada SKIPPED, sem tentativas", async () => {
    const kit = createTestKit(prisma, clock);
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 5000, currency: "BRL" });
    await drain(kit.runner);
    const body = (await view()).body;

    expect(body.attribution).toMatchObject({ result: "UNATTRIBUTED", level: null, unattributedReason: "NO_EVIDENCE", session: null });
    expect(body.attribution.explanation).toContain("nenhuma evidência");
    expect(body.trackingData.customFields).toEqual({ value: null, source: "NONE" });
    expect(body.trackingData.affiliate).toBeNull();
    for (const c of body.conversions) {
      expect(c.status).toBe("SKIPPED");
      expect(c.attempts).toEqual([]);
      expect(c.explanation).toContain("Não foi enviado");
    }
    expect(conversion(body, "META")).toMatchObject({ skipReason: "MISSING_REQUIRED_IDENTIFIER:fbc|fbp" });
    expect(conversion(body, "META").explanation).toContain("fbc ou fbp");
  });

  it("ambiguidade: explica por que nenhuma sessão foi escolhida e lista os candidatos", async () => {
    const kit = createTestKit(prisma, clock);
    for (const id of ["A", "B"]) {
      await postSession({ sessionId: id, pageUrl: "https://a.com", customer: { email: "dupla@email.com" } });
    }
    clock.advance(3_600_000);
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 100, currency: "USD", customer: { email: "dupla@email.com" } });
    await drain(kit.runner);
    const body = (await view()).body;

    expect(body.attribution).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "AMBIGUOUS_CUSTOMER_WINDOW" });
    expect(body.attribution.explanation).toContain("Nenhuma foi escolhida");
    expect(body.attribution.decisionTrace).toContainEqual(expect.objectContaining({ step: "LEVEL_4_CUSTOMER_WINDOW", outcome: "AMBIGUOUS", candidates: ["A", "B"] }));
    assertNoLeak(body);
  });

  it("conflito de atribuição: o alerta vem com explicação e sem dados pessoais", async () => {
    const kit = createTestKit(prisma, clock);
    await postSession({ sessionId: "A", pageUrl: "https://a.com", customFields: { affiliateCode: "AFF-A" } });
    await postSession({ sessionId: "B", pageUrl: "https://a.com", identifiers: { fbclid: "f-b" } });
    await postOrder(orderPaid({ sessionId: "A", customFields: undefined, identifiers: { fbclid: "f-b" } }));
    await drain(kit.runner);
    const body = (await view()).body;

    expect(body.attribution.alerts).toHaveLength(1);
    expect(body.attribution.alerts[0]).toMatchObject({ code: "ATTRIBUTION_CONFLICT" });
    expect(body.attribution.alerts[0].explanation).toContain("nível 3");
  });

  it("afiliado registrado na atribuição de nível 4: informa que NÃO é enviado aos provedores", async () => {
    const kit = createTestKit(prisma, clock);
    await postSession();
    await postOrder(orderPaid({ sessionId: undefined }));
    await drain(kit.runner);
    const affiliate = (await view()).body.trackingData.affiliate;
    expect(affiliate).toMatchObject({ code: "AFF-001", evidenceLevel: 4, sentToProviders: false });
    expect(affiliate.explanation).toContain("NÃO é enviado");
  });

  it("falha transitória: PENDING com a próxima tentativa e o histórico do erro", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit);
    kit.simulators.GOOGLE.failNext(1, { status: 503, body: { error: { message: "indisponível" } } });
    await drain(kit.runner);
    const google = conversion((await view()).body, "GOOGLE");

    expect(google).toMatchObject({ status: "PENDING", attemptCount: 1 });
    expect(google.nextAttemptAt).toBe(new Date(clock.now().getTime() + 1000).toISOString());
    expect(google.explanation).toContain("Aguardando nova tentativa");
    expect(google.attempts[0]).toMatchObject({ attemptNumber: 1, status: "TRANSIENT_FAILURE", httpStatus: 503, error: "HTTP 503" });
    expect(google.attempts[0].response).toEqual({ error: { message: "indisponível" } });
  });

  it("falha permanente: explica o status HTTP e que não há nova tentativa automática", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit);
    kit.simulators.META.failNext(1, { status: 400 });
    await drain(kit.runner);
    const meta = conversion((await view()).body, "META");

    expect(meta).toMatchObject({ status: "FAILED_PERMANENT", failureReason: "PROVIDER_REJECTED:400" });
    expect(meta.explanation).toContain("HTTP 400");
    expect(meta.explanation).toContain("permanente");
  });

  it("conflitos de sessão aparecem com e-mail mascarado", async () => {
    const kit = createTestKit(prisma, clock);
    await postSession(richSession);
    await postSession({ ...richSession, identifiers: { fbclid: "OUTRO-FBCLID" }, customer: { email: "atacante@exemplo.com" } });
    await postOrder();
    await drain(kit.runner);
    const conflicts = (await view()).body.attribution.session.conflicts;

    expect(conflicts.map((c: any) => c.field).sort()).toEqual(["customer.email", "identifiers.fbclid"]);
    const email = conflicts.find((c: any) => c.field === "customer.email");
    expect(email).toMatchObject({ kept: "c***@email.com", received: "a***@exemplo.com" });
    expect(JSON.stringify(conflicts)).not.toContain("atacante@exemplo.com");
  });
});

describe("GET /support/orders/:orderId/tracking: eventos sem pedido", () => {
  it("evento recebido e ainda não processado: order nulo e o motivo no evento", async () => {
    await postOrder();
    const body = (await view()).body;
    expect(body.order).toBeNull();
    expect(body.attribution).toBeNull();
    expect(body.conversions).toEqual([]);
    expect(body.events).toEqual([expect.objectContaining({ status: "RECEIVED", explanation: "Recebido e aguardando processamento." })]);
  });

  it("evento não suportado: aparece como ignorado", async () => {
    await postOrder({ eventId: "evt_ref", event: "ORDER_REFUNDED", orderId: "ORD-001" });
    const body = (await view()).body;
    expect(body.order).toBeNull();
    expect(body.events[0]).toMatchObject({ eventType: "ORDER_REFUNDED", status: "IGNORED_UNSUPPORTED" });
  });

  it("segundo evento do mesmo pedido: DUPLICATE_ORDER visível, com os dois eventos", async () => {
    const kit = createTestKit(prisma, clock);
    await postSession();
    await postOrder(orderPaid({ eventId: "evt_A" }));
    await postOrder(orderPaid({ eventId: "evt_B" }));
    await drain(kit.runner);
    const body = (await view()).body;
    expect(body.events.map((e: any) => [e.eventId, e.status])).toEqual([["evt_A", "PROCESSED"], ["evt_B", "DUPLICATE_ORDER"]]);
    expect(body.events[1].explanation).toContain("Já existia um pedido");
  });

  it("pedido inexistente responde 404, e orderId absurdo responde 400", async () => {
    expect((await view("NAO-EXISTE")).status).toBe(404);
    expect((await view("x".repeat(201))).status).toBe(400);
  });
});

describe("varredura de vazamento de dados pessoais em todas as respostas", () => {
  it("nenhum cenário devolve e-mail, telefone, credencial ou dado interno", async () => {
    const kit = createTestKit(prisma, clock);
    await seed(kit);
    kit.simulators.TIKTOK.failNext(1, { status: 503 });
    kit.simulators.META.failNext(1, { status: 400 });
    await drain(kit.runner);
    assertNoLeak((await view()).body);

    await request(app).post("/support/orders/ORD-001/reprocess").set("X-API-Key", MARIA).send({ includePermanentFailures: true });
    assertNoLeak((await view()).body);
  });
});
