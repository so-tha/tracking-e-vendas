import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/shared/db.js";
import { assertTestDatabase, createTestPrisma, resetDatabase } from "./helpers/db.js";

/**
 * Prova que a idempotência está no banco (ADR-027), e não em "verificar antes de inserir".
 * Um mock de banco não provaria isto (ADR-029).
 */
const prisma = createTestPrisma();

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const newEvent = (eventId: string, orderId = "ORD-001") =>
  prisma.webhookEvent.create({
    data: { eventId, eventType: "ORDER_PAID", orderId, payload: { eventId, orderId } },
  });

async function newOrder(orderId = "ORD-001") {
  const event = await newEvent(`evt-${orderId}`, orderId);
  return prisma.order.create({
    data: {
      orderId,
      webhookEventId: event.id,
      amountMinor: 25500n,
      currency: "USD",
      receivedAt: event.receivedAt,
    },
  });
}

/** Retorna o código do erro do Prisma, se houver. */
async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("unicidades que sustentam a idempotência", () => {
  it("rejeita sessionId duplicado", async () => {
    const data = { sessionId: "session_123", pageUrl: "https://x.com" };
    await prisma.trackingSession.create({ data });
    expect(await errorCode(() => prisma.trackingSession.create({ data }))).toBe("P2002");
  });

  it("rejeita eventId duplicado", async () => {
    await newEvent("evt_123");
    expect(await errorCode(() => newEvent("evt_123", "ORD-002"))).toBe("P2002");
  });

  it("rejeita orderId duplicado com eventId diferente (ADR-015)", async () => {
    await newOrder("ORD-001");
    const second = await newEvent("evt-outro", "ORD-001");
    const code = await errorCode(() =>
      prisma.order.create({
        data: {
          orderId: "ORD-001",
          webhookEventId: second.id,
          amountMinor: 100n,
          currency: "USD",
          receivedAt: second.receivedAt,
        },
      }),
    );
    expect(code).toBe("P2002");
  });

  it("rejeita segunda conversão para o mesmo pedido e provedor", async () => {
    const order = await newOrder();
    const data = { orderRefId: order.id, provider: "META" as const, dedupKey: "ORD-001:META:ORDER_PAID" };
    await prisma.conversion.create({ data });
    expect(await errorCode(() => prisma.conversion.create({ data }))).toBe("P2002");
  });

  it("permite o mesmo pedido em provedores diferentes", async () => {
    const order = await newOrder();
    await prisma.conversion.create({ data: { orderRefId: order.id, provider: "META", dedupKey: "k-meta" } });
    await prisma.conversion.create({ data: { orderRefId: order.id, provider: "GOOGLE", dedupKey: "k-google" } });
    expect(await prisma.conversion.count()).toBe(2);
  });

  it("rejeita segundo snapshot de atribuição para o mesmo pedido (ADR-010)", async () => {
    const order = await newOrder();
    const data = {
      orderRefId: order.id,
      result: "UNATTRIBUTED" as const,
      customFieldsSource: "NONE",
      identifiers: {},
      alerts: [],
      decisionTrace: [],
    };
    await prisma.attributionSnapshot.create({ data });
    expect(await errorCode(() => prisma.attributionSnapshot.create({ data }))).toBe("P2002");
  });

  it("rejeita tentativa repetida com o mesmo número", async () => {
    const order = await newOrder();
    const conversion = await prisma.conversion.create({
      data: { orderRefId: order.id, provider: "META", dedupKey: "k" },
    });
    const data = {
      conversionRefId: conversion.id,
      attemptNumber: 1,
      status: "SUCCESS" as const,
      requestPayload: {},
      startedAt: new Date(),
      finishedAt: new Date(),
    };
    await prisma.deliveryAttempt.create({ data });
    expect(await errorCode(() => prisma.deliveryAttempt.create({ data }))).toBe("P2002");
  });

  it("rejeita job com dedupKey repetida", async () => {
    const data = { type: "PROCESS_ORDER_EVENT", payload: {}, dedupKey: "process:evt_123" };
    await prisma.job.create({ data });
    expect(await errorCode(() => prisma.job.create({ data }))).toBe("P2002");
  });
});

describe("concorrência", () => {
  it("com 10 inserts simultâneos do mesmo eventId, exatamente um vence", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => newEvent("evt_concorrente")),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejectedCodes = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason as { code?: string }).code);

    expect(fulfilled).toBe(1);
    expect(rejectedCodes).toHaveLength(9);
    expect(new Set(rejectedCodes)).toEqual(new Set(["P2002"]));
    expect(await prisma.webhookEvent.count({ where: { eventId: "evt_concorrente" } })).toBe(1);
  });

  it("com 10 conversões simultâneas do mesmo pedido e provedor, exatamente uma vence", async () => {
    const order = await newOrder();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        prisma.conversion.create({
          data: { orderRefId: order.id, provider: "TIKTOK", dedupKey: "ORD-001:TIKTOK:ORDER_PAID" },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.conversion.count()).toBe(1);
  });
});

describe("representação de dados", () => {
  it("guarda valores acima de 32 bits em amountMinor (ADR-017)", async () => {
    const event = await newEvent("evt-grande");
    const big = 9_000_000_000n;
    const order = await prisma.order.create({
      data: { orderId: "ORD-GRANDE", webhookEventId: event.id, amountMinor: big, currency: "USD", receivedAt: event.receivedAt },
    });
    const loaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(loaded.amountMinor).toBe(big);
  });

  it("preserva o payload original do webhook sem alterações (RF-06)", async () => {
    const payload = {
      eventId: "evt_123",
      customFields: { source: "facebook", campaign: "black-friday" },
      extra: { nested: [1, 2, { a: null }] },
    };
    await prisma.webhookEvent.create({
      data: { eventId: "evt_123", eventType: "ORDER_PAID", orderId: "ORD-001", payload },
    });
    const loaded = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId: "evt_123" } });
    expect(loaded.payload).toEqual(payload);
  });
});

describe("trava de segurança dos testes", () => {
  it("recusa limpar um banco que não seja de teste", () => {
    expect(() => assertTestDatabase("postgresql://u:p@localhost:5432/tracking_hub")).toThrow(/não parece um banco de teste/);
    expect(() => assertTestDatabase("postgresql://u:p@localhost:5432/tracking_hub_test")).not.toThrow();
  });
});

export type { PrismaClient };
