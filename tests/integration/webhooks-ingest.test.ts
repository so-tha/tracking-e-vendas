import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma, resetDatabase } from "./helpers/db.js";
import { createClock, orderPaid } from "./helpers/orders.js";

const prisma = createTestPrisma();
const clock = createClock();
const app = createApp({ prisma, logger: createLogger({ level: "silent" }), now: clock.now });

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

const post = (body: unknown) => request(app).post("/webhooks/orders").send(body as object);

describe("POST /webhooks/orders: recebimento", () => {
  it("aceita o exemplo do documento com 202, grava o evento e enfileira o job", async () => {
    const res = await post(orderPaid());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ eventId: "evt_123", status: "accepted", ignored: false, warnings: [] });

    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_123" } });
    expect(event).toMatchObject({ eventType: "ORDER_PAID", orderId: "ORD-001", status: "RECEIVED", processedAt: null });
    expect(event.receivedAt).toEqual(clock.now());

    const jobs = await prisma.job.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "PROCESS_ORDER_EVENT", status: "PENDING", payload: { eventId: "evt_123" },
      dedupKey: "process-order-event:evt_123", attempts: 0,
    });
  });

  it("preserva o payload original integralmente, inclusive campos desconhecidos (RF-06)", async () => {
    const body = orderPaid({ extra: { nested: [1, 2, { a: null }] }, customer: { email: "  Cliente@Email.COM  ", phone: "x" } });
    await post(body);
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_123" } });
    expect(event.payload).toEqual(body);
  });

  it("não cria o pedido na requisição: o processamento é assíncrono (RF-02)", async () => {
    await post(orderPaid());
    expect(await prisma.order.count()).toBe(0);
  });

  it("aceita venda sem sessão, sem cliente e sem customFields", async () => {
    const res = await post({ eventId: "e1", event: "ORDER_PAID", orderId: "o1", amount: 100, currency: "BRL" });
    expect(res.status).toBe(202);
    expect(res.body.warnings).toEqual([]);
  });

  it("campos opcionais malformados não derrubam a venda: aviso sem valores, payload preservado", async () => {
    const res = await post(orderPaid({ customer: { email: "ruim-SEGREDO" }, sessionId: "com espaço", identifiers: "texto" }));
    expect(res.status).toBe(202);
    expect(res.body.warnings).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toContain("SEGREDO");
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_123" } });
    expect(event.statusReason).toContain("customer.email ignorado");
    expect((event.payload as { customer: { email: string } }).customer.email).toBe("ruim-SEGREDO");
  });
});

describe("POST /webhooks/orders: idempotência por eventId (caso de teste 3)", () => {
  it("o mesmo evento duas vezes: um evento, um job, resposta duplicate", async () => {
    await post(orderPaid());
    const res = await post(orderPaid());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ eventId: "evt_123", status: "duplicate", ignored: false, warnings: [] });
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it("eventId repetido com payload diferente mantém o original", async () => {
    await post(orderPaid({ amount: 25500 }));
    const res = await post(orderPaid({ amount: 99999 }));
    expect(res.body.status).toBe("duplicate");
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_123" } });
    expect((event.payload as { amount: number }).amount).toBe(25500);
  });

  it("20 envios simultâneos do mesmo evento: exatamente 1 accepted, 19 duplicate, 1 evento, 1 job", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(orderPaid())));
    expect(responses.every((r) => r.status === 202)).toBe(true);
    expect(responses.filter((r) => r.body.status === "accepted")).toHaveLength(1);
    expect(responses.filter((r) => r.body.status === "duplicate")).toHaveLength(19);
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it("eventIds diferentes para o mesmo pedido são ambos registrados na recepção", async () => {
    await post(orderPaid({ eventId: "evt_A" }));
    await post(orderPaid({ eventId: "evt_B" }));
    expect(await prisma.webhookEvent.count()).toBe(2);
    expect(await prisma.job.count()).toBe(2);
  });
});

describe("POST /webhooks/orders: eventos não suportados (ADR-005)", () => {
  it("registra com o payload original, não enfileira e não cria pedido", async () => {
    const body = { eventId: "evt_ref", event: "ORDER_REFUNDED", orderId: "ORD-001", amount: 100, anything: true };
    const res = await post(body);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "accepted", ignored: true });

    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_ref" } });
    expect(event).toMatchObject({ status: "IGNORED_UNSUPPORTED", eventType: "ORDER_REFUNDED" });
    expect(event.processedAt).toEqual(clock.now());
    expect(event.payload).toEqual(body);
    expect(await prisma.job.count()).toBe(0);
    expect(await prisma.order.count()).toBe(0);
  });

  it("evento não suportado repetido também é idempotente", async () => {
    const body = { eventId: "evt_ref", event: "ORDER_REFUNDED", orderId: "o" };
    await post(body);
    const res = await post(body);
    expect(res.body.status).toBe("duplicate");
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it("o nome do evento diferencia maiúsculas: order_paid não é processado", async () => {
    const res = await post(orderPaid({ event: "order_paid" }));
    expect(res.body).toMatchObject({ ignored: true });
    expect(await prisma.job.count()).toBe(0);
  });
});

describe("POST /webhooks/orders: validação", () => {
  it.each([
    ["sem eventId", orderPaid({ eventId: undefined })],
    ["sem event", orderPaid({ event: undefined })],
    ["sem orderId", orderPaid({ orderId: undefined })],
    ["ORDER_PAID sem amount", orderPaid({ amount: undefined })],
    ["ORDER_PAID sem currency", orderPaid({ currency: undefined })],
    ["amount decimal", orderPaid({ amount: 10.5 })],
    ["amount negativo", orderPaid({ amount: -5 })],
    ["moeda inválida", orderPaid({ currency: "ZZZ" })],
  ])("responde 400 e não grava nada: %s", async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("não ecoa valores recebidos no erro", async () => {
    const res = await post(orderPaid({ currency: "MOEDA-SECRETA" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("MOEDA-SECRETA");
  });

  it("evento não suportado não exige amount nem currency", async () => {
    const res = await post({ eventId: "e", event: "ORDER_REFUNDED", orderId: "o" });
    expect(res.status).toBe(202);
  });

  it("responde 400 sem corpo", async () => {
    expect((await request(app).post("/webhooks/orders")).status).toBe(400);
  });
});
