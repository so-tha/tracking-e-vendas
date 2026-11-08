import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { orderLockKey } from "../../src/modules/orders/process.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma, resetDatabase } from "./helpers/db.js";
import { createSimulatedEnvironment } from "../../src/modules/conversions/providers/index.js";
import { createClock, createTestRunner, drain, orderPaid, testProvidersConfig } from "./helpers/orders.js";

const prisma = createTestPrisma();
const clock = createClock();
const app = createApp({ prisma, logger: createLogger({ level: "silent" }), now: clock.now });
const runner = createTestRunner(prisma, clock);

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set("2026-01-01T12:00:00.000Z");
});
afterAll(async () => {
  await prisma.$disconnect();
});

const post = (body: unknown) => request(app).post("/webhooks/orders").send(body as object);
const events = () => prisma.webhookEvent.findMany({ orderBy: { eventId: "asc" } });

describe("processamento do pedido pelo worker", () => {
  it("cria o pedido com valor em centavos, moeda e instante da primeira recepção", async () => {
    await post(orderPaid());
    clock.advance(30_000);
    await drain(runner);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderId: "ORD-001" } });
    expect(order).toMatchObject({
      amountMinor: 25500n, currency: "USD", customerEmail: "cliente@email.com", webhookSessionId: "session_123",
    });
    // receivedAt vem do evento (recepção), e não do momento do processamento (ADR-013).
    expect(order.receivedAt).toEqual(new Date("2026-01-01T12:00:00.000Z"));

    const [event] = await events();
    expect(event).toMatchObject({ status: "PROCESSED" });
    expect(event?.processedAt).toEqual(new Date("2026-01-01T12:00:30.000Z"));
    expect((await prisma.job.findFirstOrThrow()).status).toBe("DONE");
  });

  it("registra venda sem sessão normalmente (RF-05)", async () => {
    await post({ eventId: "e1", event: "ORDER_PAID", orderId: "o1", amount: 100, currency: "BRL" });
    await drain(runner);
    expect(await prisma.order.findUniqueOrThrow({ where: { orderId: "o1" } })).toMatchObject({
      webhookSessionId: null, customerEmail: null, amountMinor: 100n,
    });
  });

  it("guarda valores acima de 32 bits", async () => {
    await post(orderPaid({ amount: 9_000_000_000 }));
    await drain(runner);
    expect((await prisma.order.findFirstOrThrow()).amountMinor).toBe(9_000_000_000n);
  });

  it("normaliza o e-mail do cliente", async () => {
    await post(orderPaid({ customer: { email: "  Cliente@Email.COM " } }));
    await drain(runner);
    expect((await prisma.order.findFirstOrThrow()).customerEmail).toBe("cliente@email.com");
  });
});

describe("idempotência no processamento (caso de teste 3)", () => {
  it("evento repetido: um pedido, um job processado", async () => {
    await post(orderPaid());
    await post(orderPaid());
    await post(orderPaid());
    await drain(runner);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.job.count({ where: { type: "PROCESS_ORDER_EVENT" } })).toBe(1);
    // As conversões também nascem uma vez por provedor (RF-03).
    expect(await prisma.conversion.count()).toBe(5);
  });

  it("mesmo orderId com eventId diferente: o segundo vira DUPLICATE_ORDER e não cria outro pedido (ADR-015)", async () => {
    await post(orderPaid({ eventId: "evt_A" }));
    await post(orderPaid({ eventId: "evt_B", amount: 99999 }));
    await drain(runner);

    expect(await prisma.order.count()).toBe(1);
    const order = await prisma.order.findFirstOrThrow();
    expect(order.amountMinor).toBe(25500n);

    const byId = Object.fromEntries((await events()).map((e) => [e.eventId, e]));
    expect(byId["evt_A"]?.status).toBe("PROCESSED");
    expect(byId["evt_B"]?.status).toBe("DUPLICATE_ORDER");
    expect(byId["evt_B"]?.statusReason).toContain("pedido já criado pelo evento");
    expect(byId["evt_B"]?.processedAt).not.toBeNull();
  });

  it("eventos do mesmo pedido processados em paralelo por workers diferentes: um pedido só", async () => {
    for (let n = 0; n < 8; n++) await post(orderPaid({ eventId: `evt_${n}` }));
    const runners = Array.from({ length: 4 }, (_, w) => createTestRunner(prisma, clock, { workerId: `w${w}` }));
    await Promise.all(runners.map((r) => drain(r)));

    expect(await prisma.order.count()).toBe(1);
    const statuses = (await events()).map((e) => e.status);
    expect(statuses.filter((s) => s === "PROCESSED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "DUPLICATE_ORDER")).toHaveLength(7);
    expect(await prisma.job.count({ where: { type: "PROCESS_ORDER_EVENT", status: "DONE" } })).toBe(8);
    expect(await prisma.conversion.count()).toBe(5);
  });

  it("reexecutar o job de um evento já processado não faz nada", async () => {
    await post(orderPaid());
    await drain(runner);
    await prisma.job.updateMany({ data: { status: "PENDING", attempts: 0, runAt: clock.now() } });
    await drain(runner);
    expect(await prisma.order.count()).toBe(1);
    expect((await events())[0]?.status).toBe("PROCESSED");
  });
});

describe("lock por pedido, verificado de forma determinística", () => {
  it("o processamento espera enquanto outra transação segura o lock do mesmo pedido, e só depois cria o pedido", async () => {
    await post(orderPaid());

    let processing: Promise<boolean> | undefined;
    let ordersWhileLocked = -1;
    let eventStatusWhileLocked = "";

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orderLockKey("ORD-001")}, 0))`;
      processing = runner.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 600));
      ordersWhileLocked = await prisma.order.count();
      eventStatusWhileLocked = (await prisma.webhookEvent.findFirstOrThrow()).status;
    });

    // Enquanto o lock estava seguro, o handler não pôde avançar.
    expect(ordersWhileLocked).toBe(0);
    expect(eventStatusWhileLocked).toBe("RECEIVED");

    await processing;
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.webhookEvent.findFirstOrThrow()).status).toBe("PROCESSED");
  });

  it("o lock de um pedido não bloqueia o processamento de outro pedido", async () => {
    await post(orderPaid({ eventId: "evt_other", orderId: "ORD-OTHER" }));

    let finishedWhileOtherLocked = false;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orderLockKey("ORD-001")}, 0))`;
      await runner.runOnce();
      finishedWhileOtherLocked = (await prisma.order.count({ where: { orderId: "ORD-OTHER" } })) === 1;
    });
    expect(finishedWhileOtherLocked).toBe(true);
  });
});

describe("eventos não suportados e falhas", () => {
  it("evento não suportado nunca cria pedido, mesmo para um orderId existente", async () => {
    await post(orderPaid());
    await post({ eventId: "evt_ref", event: "ORDER_REFUNDED", orderId: "ORD-001" });
    await drain(runner);
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_ref" } })).status).toBe("IGNORED_UNSUPPORTED");
  });

  it("falha transitória do banco no meio do processamento: o job é repetido e o pedido é criado uma vez", async () => {
    await post(orderPaid());
    let failuresLeft = 1;
    const flaky = createTestRunner(prisma, clock, {
      handlers: {
        PROCESS_ORDER_EVENT: async (job) => {
          if (failuresLeft-- > 0) throw new Error("conexão perdida");
          const { createProcessOrderEvent } = await import("../../src/modules/orders/process.js");
          await createProcessOrderEvent(prisma, clock.now, { matchWindowHours: 24, providers: createSimulatedEnvironment(testProvidersConfig).registry })(job);
        },
      },
    });
    await flaky.runOnce();
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.job.findFirstOrThrow()).status).toBe("PENDING");

    clock.advance(10_000);
    await drain(flaky);
    expect(await prisma.order.count()).toBe(1);
    expect((await prisma.job.findFirstOrThrow()).status).toBe("DONE");
  });

  it("job apontando para evento inexistente falha de vez, sem loop", async () => {
    await prisma.job.create({
      data: { type: "PROCESS_ORDER_EVENT", payload: { eventId: "nao-existe" }, dedupKey: "x", runAt: clock.now() },
    });
    await drain(runner);
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({ status: "FAILED", attempts: 1 });
  });
});
