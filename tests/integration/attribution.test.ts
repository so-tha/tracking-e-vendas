import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createSessionLookup } from "../../src/modules/attribution/repository.js";
import { createProcessOrderEvent } from "../../src/modules/orders/process.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma, resetDatabase } from "./helpers/db.js";
import { createSimulatedEnvironment } from "../../src/modules/conversions/providers/index.js";
import { createClock, createTestRunner, drain, orderPaid, testProvidersConfig } from "./helpers/orders.js";

const prisma = createTestPrisma();
const clock = createClock("2026-01-10T12:00:00.000Z");
const app = createApp({ prisma, logger: createLogger({ level: "silent" }), now: clock.now });
const runner = createTestRunner(prisma, clock);

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set("2026-01-10T12:00:00.000Z");
});
afterAll(async () => {
  await prisma.$disconnect();
});

const fullSession = {
  sessionId: "session_123",
  pageUrl: "https://checkout.exemplo.com/produto",
  customFields: { source: "facebook", campaign: "black-friday", content: "criativo-01", affiliateCode: "AFF-001" },
  identifiers: {
    fbclid: "fb-click-id", fbc: "meta-fbc", fbp: "meta-fbp", gclid: "google-click-id", gbraid: null, wbraid: null,
    ttclid: "tiktok-click-id", ttp: "tiktok-cookie", redtrackClickId: "redtrack-click-id", utmifyId: "utmify-id",
  },
  customer: { email: "cliente@email.com", phone: "+5511999999999" },
};

const postSession = (body: unknown) => request(app).post("/tracking/sessions").send(body as object);
const postOrder = (body: unknown) => request(app).post("/webhooks/orders").send(body as object);
const snapshot = async (orderId = "ORD-001") => {
  const order = await prisma.order.findUniqueOrThrow({ where: { orderId } });
  return prisma.attributionSnapshot.findUniqueOrThrow({ where: { orderRefId: order.id } });
};

describe("caso 1: venda relacionada corretamente por sessionId", () => {
  it("atribui no nível 1 e registra a origem de cada dado", async () => {
    await postSession(fullSession);
    clock.advance(60_000);
    await postOrder(orderPaid());
    await drain(runner);

    const snap = await snapshot();
    const session = await prisma.trackingSession.findUniqueOrThrow({ where: { sessionId: "session_123" } });
    expect(snap).toMatchObject({
      result: "ATTRIBUTED", level: 1, method: "SESSION_ID", sessionRefId: session.id,
      customFieldsSource: "WEBHOOK", unattributedReason: null,
      affiliateCode: "AFF-001", affiliateCodeSource: "WEBHOOK", affiliateEvidenceLevel: 1,
    });
    expect(snap.alerts).toEqual([]);
    expect(snap.customFields).toEqual(fullSession.customFields);
  });
});

describe("caso 2: venda sem tracking registrada como não atribuída", () => {
  it("cria o pedido normalmente e o snapshot UNATTRIBUTED, sem inventar campanha", async () => {
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 5000, currency: "BRL" });
    await drain(runner);

    expect(await prisma.order.count()).toBe(1);
    expect(await snapshot()).toMatchObject({
      result: "UNATTRIBUTED", level: null, sessionRefId: null, unattributedReason: "NO_EVIDENCE",
      customFields: null, customFieldsSource: "NONE", affiliateCode: null,
    });
  });

  it("webhook com sessionId que não existe também não é atribuído", async () => {
    await postOrder(orderPaid({ sessionId: "fantasma" }));
    await drain(runner);
    expect(await snapshot()).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "NO_MATCHING_SESSION" });
  });
});

describe("caso 4: webhook sem dados de campanha recupera customFields da sessão", () => {
  it("usa o objeto da sessão com origem SESSION e afiliado com a mesma origem", async () => {
    await postSession(fullSession);
    await postOrder(orderPaid({ customFields: undefined }));
    await drain(runner);

    expect(await snapshot()).toMatchObject({
      result: "ATTRIBUTED", customFields: fullSession.customFields, customFieldsSource: "SESSION",
      affiliateCode: "AFF-001", affiliateCodeSource: "SESSION", affiliateEvidenceLevel: 1,
    });
  });
});

describe("caso 7: pixel capturado, mas webhook sem click ID", () => {
  it("atribui pelo nível 1 e recupera todos os identificadores da sessão, com origem SESSION", async () => {
    await postSession(fullSession);
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", sessionId: "session_123", amount: 25500, currency: "USD" });
    await drain(runner);

    const snap = await snapshot();
    expect(snap).toMatchObject({ result: "ATTRIBUTED", level: 1 });
    expect(snap.identifiers).toEqual({
      fbclid: { value: "fb-click-id", source: "SESSION" }, fbc: { value: "meta-fbc", source: "SESSION" },
      fbp: { value: "meta-fbp", source: "SESSION" }, gclid: { value: "google-click-id", source: "SESSION" },
      ttclid: { value: "tiktok-click-id", source: "SESSION" }, ttp: { value: "tiktok-cookie", source: "SESSION" },
      redtrackClickId: { value: "redtrack-click-id", source: "SESSION" }, utmifyId: { value: "utmify-id", source: "SESSION" },
    });
  });
});

describe("caso 8: duas sessões para o mesmo cliente sem atribuição incorreta", () => {
  it("não atribui quando há ambiguidade, e nenhuma das sessões é escolhida", async () => {
    await postSession({ sessionId: "A", pageUrl: "https://a.com", customFields: { affiliateCode: "AFF-A" }, customer: { email: "cliente@email.com" } });
    clock.advance(3_600_000);
    await postSession({ sessionId: "B", pageUrl: "https://a.com", customFields: { affiliateCode: "AFF-B" }, customer: { email: "cliente@email.com" } });
    clock.advance(3_600_000);
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 100, currency: "USD", customer: { email: "cliente@email.com" } });
    await drain(runner);

    const snap = await snapshot();
    expect(snap).toMatchObject({
      result: "UNATTRIBUTED", sessionRefId: null, level: null,
      unattributedReason: "AMBIGUOUS_CUSTOMER_WINDOW", affiliateCode: null,
    });
    expect(snap.customFields).toBeNull();
    expect(snap.decisionTrace).toContainEqual(
      expect.objectContaining({ step: "LEVEL_4_CUSTOMER_WINDOW", outcome: "AMBIGUOUS", candidates: ["A", "B"] }),
    );
  });

  it("com uma única sessão do cliente na janela, atribui pelo nível 4 e guarda o nível de evidência", async () => {
    await postSession({ sessionId: "A", pageUrl: "https://a.com", customFields: { source: "facebook", affiliateCode: "AFF-A" }, customer: { email: "cliente@email.com" } });
    clock.advance(3_600_000);
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 100, currency: "USD", customer: { email: "CLIENTE@email.com" } });
    await drain(runner);
    expect(await snapshot()).toMatchObject({
      result: "ATTRIBUTED", level: 4, method: "CUSTOMER_WINDOW",
      customFieldsSource: "SESSION", affiliateCode: "AFF-A", affiliateEvidenceLevel: 4,
    });
  });
});

describe("níveis 2 e 3 pelo banco", () => {
  it("atribui por click ID do webhook (nível 3) e por utmifyId (nível 2)", async () => {
    await postSession({ sessionId: "S1", pageUrl: "https://a.com", identifiers: { gclid: "g-1" } });
    await postSession({ sessionId: "S2", pageUrl: "https://a.com", identifiers: { utmifyId: "u-2" } });
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "O1", amount: 1, currency: "USD", identifiers: { gclid: "g-1" } });
    await postOrder({ eventId: "e2", event: "ORDER_PAID", orderId: "O2", amount: 1, currency: "USD", identifiers: { utmifyId: "u-2" } });
    await drain(runner);
    expect(await snapshot("O1")).toMatchObject({ result: "ATTRIBUTED", level: 3, method: "CLICK_ID" });
    expect(await snapshot("O2")).toMatchObject({ result: "ATTRIBUTED", level: 2, method: "PLATFORM_IDENTIFIER" });
  });

  it("fbp sozinho não atribui, mesmo existindo uma sessão com o mesmo fbp", async () => {
    await postSession({ sessionId: "S1", pageUrl: "https://a.com", identifiers: { fbp: "fb.1.cookie" } });
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "O1", amount: 1, currency: "USD", identifiers: { fbp: "fb.1.cookie" } });
    await drain(runner);
    expect(await snapshot("O1")).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "NO_EVIDENCE" });
  });

  it("o mesmo click ID em duas sessões: não atribui", async () => {
    await postSession({ sessionId: "S1", pageUrl: "https://a.com", identifiers: { fbclid: "f-1" } });
    await postSession({ sessionId: "S2", pageUrl: "https://a.com", identifiers: { fbclid: "f-1" } });
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "O1", amount: 1, currency: "USD", identifiers: { fbclid: "f-1" } });
    await drain(runner);
    expect(await snapshot("O1")).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "AMBIGUOUS_CLICK_ID" });
  });

  it("sem sessão, identificadores do webhook ficam no snapshot com origem WEBHOOK", async () => {
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "O1", amount: 1, currency: "USD", identifiers: { gclid: "g-solto", fbp: "p-solto" } });
    await drain(runner);
    expect((await snapshot("O1")).identifiers).toEqual({
      gclid: { value: "g-solto", source: "WEBHOOK" }, fbp: { value: "p-solto", source: "WEBHOOK" },
    });
  });
});

describe("conflito entre evidências (ADR-012)", () => {
  it("sessionId vence, e o ATTRIBUTION_CONFLICT fica no snapshot", async () => {
    await postSession({ sessionId: "A", pageUrl: "https://a.com", customFields: { affiliateCode: "AFF-A" } });
    await postSession({ sessionId: "B", pageUrl: "https://a.com", identifiers: { fbclid: "f-b" } });
    await postOrder(orderPaid({ sessionId: "A", customFields: undefined, identifiers: { fbclid: "f-b" } }));
    await drain(runner);

    const snap = await snapshot();
    expect(snap).toMatchObject({ result: "ATTRIBUTED", level: 1, affiliateCode: "AFF-A" });
    expect(snap.alerts).toEqual([
      { code: "ATTRIBUTION_CONFLICT", details: [{ kind: "OTHER_SESSION_EVIDENCE", level: 3, method: "CLICK_ID", sessionIds: ["B"] }] },
    ]);
  });
});

describe("janela e relógio (ADR-013)", () => {
  it("a janela é medida pelo receivedAt do evento, e não pelo momento do processamento", async () => {
    await postSession({ sessionId: "A", pageUrl: "https://a.com", customer: { email: "cliente@email.com" } });
    clock.advance(2 * 3_600_000);
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 1, currency: "USD", customer: { email: "cliente@email.com" } });
    // O worker só roda 5 dias depois. Pelo relógio de processamento a sessão estaria fora da janela.
    clock.advance(5 * 24 * 3_600_000);
    await drain(runner);
    expect(await snapshot()).toMatchObject({ result: "ATTRIBUTED", level: 4 });
  });

  it("respeita a janela configurada (TRACKING_MATCH_WINDOW_HOURS)", async () => {
    await postSession({ sessionId: "A", pageUrl: "https://a.com", customer: { email: "cliente@email.com" } });
    clock.advance(3 * 3_600_000);
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 1, currency: "USD", customer: { email: "cliente@email.com" } });
    const narrow = createTestRunner(prisma, clock, {}, 1);
    await drain(narrow);
    expect(await snapshot()).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "NO_MATCHING_SESSION" });
  });
});

describe("snapshot imutável e atômico (ADR-010, ADR-023)", () => {
  it("reprocessar o job não recalcula nem duplica o snapshot", async () => {
    await postSession(fullSession);
    await postOrder(orderPaid());
    await drain(runner);
    const before = await snapshot();

    await prisma.job.updateMany({ data: { status: "PENDING", attempts: 0, runAt: clock.now() } });
    await drain(runner);

    expect(await prisma.attributionSnapshot.count()).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it("uma sessão que chega depois do pedido não altera o snapshot (limitação conhecida)", async () => {
    await postOrder({ eventId: "e1", event: "ORDER_PAID", orderId: "ORD-001", amount: 1, currency: "USD", customer: { email: "cliente@email.com" } });
    await drain(runner);
    expect(await snapshot()).toMatchObject({ result: "UNATTRIBUTED" });

    await postSession({ sessionId: "tardia", pageUrl: "https://a.com", customer: { email: "cliente@email.com" } });
    await prisma.job.updateMany({ data: { status: "PENDING", attempts: 0, runAt: clock.now() } });
    await drain(runner);
    expect(await snapshot()).toMatchObject({ result: "UNATTRIBUTED" });
  });

  it("se a atribuição falhar, o pedido não é criado e o job é repetido (mesma transação)", async () => {
    await postOrder(orderPaid());
    let calls = 0;
    const failing = createTestRunner(prisma, clock, {
      handlers: {
        PROCESS_ORDER_EVENT: createProcessOrderEvent(prisma, clock.now, {
          matchWindowHours: 24,
          providers: createSimulatedEnvironment(testProvidersConfig).registry,
          attribute: async () => { calls++; throw new Error("falha simulada na atribuição"); },
        }),
      },
    });
    await failing.runOnce();

    expect(calls).toBe(1);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.attributionSnapshot.count()).toBe(0);
    expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe("RECEIVED");
    expect((await prisma.job.findFirstOrThrow()).status).toBe("PENDING");

    clock.advance(10_000);
    await drain(runner);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.attributionSnapshot.count()).toBe(1);
  });

  it("um segundo evento do mesmo pedido (DUPLICATE_ORDER) não cria outro snapshot", async () => {
    await postSession(fullSession);
    await postOrder(orderPaid({ eventId: "evt_A" }));
    await postOrder(orderPaid({ eventId: "evt_B" }));
    await drain(runner);
    expect(await prisma.attributionSnapshot.count()).toBe(1);
  });
});

describe("rastro de decisão auditável", () => {
  it("o snapshot explica cada nível consultado, sem gravar valores sensíveis", async () => {
    await postSession({ ...fullSession, customer: { email: "segredo@email.com" } });
    await postOrder(orderPaid({ customer: { email: "segredo@email.com" }, identifiers: { fbclid: "fb-click-id" } }));
    await drain(runner);

    const snap = await snapshot();
    const trace = snap.decisionTrace as { step: string; outcome: string }[];
    expect(trace.map((t) => t.step)).toEqual([
      "LEVEL_1_SESSION_ID", "LEVEL_2_PLATFORM_IDENTIFIER", "LEVEL_3_CLICK_ID", "LEVEL_4_CUSTOMER_WINDOW",
    ]);
    expect(JSON.stringify(snap.decisionTrace)).not.toContain("segredo@email.com");
    expect(JSON.stringify(snap.decisionTrace)).not.toContain("fb-click-id");
  });
});

describe("repositório de sessões (consultas reais)", () => {
  const lookup = createSessionLookup(prisma);

  it("findByCustomerEmail usa firstSeenAt com limites inclusivos", async () => {
    const base = new Date("2026-01-09T12:00:00.000Z");
    for (const [sid, ms] of [["no-limite-inferior", 0], ["um-ms-antes", -1], ["no-limite-superior", 24 * 3_600_000]] as const) {
      await prisma.trackingSession.create({
        data: { sessionId: sid, pageUrl: "https://a.com", customerEmail: "c@e.com", firstSeenAt: new Date(base.getTime() + ms), lastSeenAt: new Date(base.getTime() + ms) },
      });
    }
    const found = await lookup.findByCustomerEmail("c@e.com", base, new Date(base.getTime() + 24 * 3_600_000));
    expect(found.map((s) => s.sessionId).sort()).toEqual(["no-limite-inferior", "no-limite-superior"]);
  });

  it("findByIdentifier busca por igualdade exata no campo certo", async () => {
    await prisma.trackingSession.create({ data: { sessionId: "S", pageUrl: "https://a.com", gclid: "ABC", fbclid: "xyz" } });
    expect(await lookup.findByIdentifier("gclid", "ABC")).toHaveLength(1);
    expect(await lookup.findByIdentifier("gclid", "abc")).toHaveLength(0);
    expect(await lookup.findByIdentifier("fbclid", "ABC")).toHaveLength(0);
  });

  it("funciona também dentro de uma transação", async () => {
    await prisma.trackingSession.create({ data: { sessionId: "S", pageUrl: "https://a.com" } });
    const found = await prisma.$transaction((tx) => createSessionLookup(tx).findBySessionId("S"));
    expect(found?.sessionId).toBe("S");
  });
});
