import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { enqueueJob } from "../../shared/queue.js";
import { DELIVER_CONVERSION } from "../conversions/create.js";
import { PROVIDER_NAMES } from "../conversions/types.js";
import { PROCESS_ORDER_EVENT } from "../orders/ingest.js";

export interface ReprocessInput {
  orderId: string;
  /** Vem da configuração da chave validada, nunca do cliente. */
  operator: string;
  includePermanentFailures: boolean;
  now: Date;
}

export interface ReprocessAction {
  target: string;
  action:
    | "ENQUEUED"
    | "RESET_AND_ENQUEUED"
    | "ALREADY_SCHEDULED"
    | "NOTHING_TO_DO"
    | "NOT_RETRIED_PERMANENT_FAILURE"
    | "NOT_RETRYABLE";
  reason?: string;
}

export interface ReprocessOutcome {
  requestId: string;
  orderId: string;
  requestedBy: string;
  requestedAt: Date;
  includePermanentFailures: boolean;
  events: ReprocessAction[];
  conversions: ReprocessAction[];
}

/** Falhas que repetir o envio não resolve. Nem o pedido explícito as reinicia. */
const NOT_RETRYABLE = /^(EVENT_TOO_OLD|CONTRACT_ERROR:)/;

const ACTIVE = ["PENDING", "RUNNING"] as const;

/**
 * Reprocessa um pedido. Reaproveita o snapshot e o evento congelado, então a atribuição
 * e o payload não mudam. Só mexe no que ainda não foi entregue:
 * - DELIVERED e SKIPPED: nada a fazer;
 * - PENDING com job ativo: respeita o backoff já agendado, não acelera nem duplica;
 * - PENDING sem job ativo (job perdido): reenfileira;
 * - FAILED_PERMANENT: só com o pedido explícito, e só se repetir pode resolver. Ganha um orçamento novo de tentativas.
 * Eventos ainda não processados cujo job se perdeu também são reenfileirados.
 *
 * O lock por pedido serializa pedidos simultâneos de reprocessamento: o segundo encontra o job do primeiro.
 */
export async function reprocessOrder(prisma: PrismaClient, input: ReprocessInput): Promise<ReprocessOutcome | null> {
  const { orderId, operator, includePermanentFailures, now } = input;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reprocess:${orderId}`}, 0))`;

    const order = await tx.order.findUnique({ where: { orderId }, include: { conversions: true } });
    const events = await tx.webhookEvent.findMany({ where: { orderId }, orderBy: { receivedAt: "asc" } });
    if (!order && events.length === 0) return null;

    const request = await tx.reprocessRequest.create({
      data: { orderId, orderRefId: order?.id ?? null, requestedBy: operator, requestedAt: now, includePermanentFailures },
    });

    const hasActiveJob = async (type: string, keyPrefix: string): Promise<boolean> =>
      (await tx.job.count({ where: { type, status: { in: [...ACTIVE] }, dedupKey: { startsWith: keyPrefix } } })) > 0;

    // Eventos que ainda não viraram pedido.
    const eventActions: ReprocessAction[] = [];
    for (const event of events) {
      if (event.status !== "RECEIVED") {
        eventActions.push({ target: event.eventId, action: "NOTHING_TO_DO", reason: event.status });
        continue;
      }
      const prefix = `process-order-event:${event.eventId}`;
      if (await hasActiveJob(PROCESS_ORDER_EVENT, prefix)) {
        eventActions.push({ target: event.eventId, action: "ALREADY_SCHEDULED" });
        continue;
      }
      await enqueueJob(tx, {
        type: PROCESS_ORDER_EVENT,
        payload: { eventId: event.eventId },
        dedupKey: `${prefix}:reprocess:${request.id}`,
        runAt: now,
      });
      eventActions.push({ target: event.eventId, action: "ENQUEUED" });
    }

    // Conversões do pedido, na ordem estável dos provedores.
    const conversionActions: ReprocessAction[] = [];
    const byProvider = new Map((order?.conversions ?? []).map((c) => [c.provider, c]));
    for (const provider of PROVIDER_NAMES) {
      const conversion = byProvider.get(provider);
      if (!conversion) continue;

      const enqueue = () =>
        enqueueJob(tx, {
          type: DELIVER_CONVERSION,
          payload: { conversionId: conversion.id },
          dedupKey: `deliver-conversion:${conversion.id}:reprocess:${request.id}`,
          runAt: now,
        });

      if (conversion.status === "DELIVERED" || conversion.status === "SKIPPED") {
        conversionActions.push({ target: provider, action: "NOTHING_TO_DO", reason: conversion.status });
      } else if (conversion.status === "PENDING") {
        if (await hasActiveJob(DELIVER_CONVERSION, `deliver-conversion:${conversion.id}`)) {
          conversionActions.push({ target: provider, action: "ALREADY_SCHEDULED" });
        } else {
          await enqueue();
          conversionActions.push({ target: provider, action: "ENQUEUED" });
        }
      } else if (!includePermanentFailures) {
        conversionActions.push({ target: provider, action: "NOT_RETRIED_PERMANENT_FAILURE", reason: conversion.failureReason ?? undefined });
      } else if (NOT_RETRYABLE.test(conversion.failureReason ?? "")) {
        conversionActions.push({ target: provider, action: "NOT_RETRYABLE", reason: conversion.failureReason ?? undefined });
      } else {
        // Orçamento novo de tentativas: o limite passa a contar a partir daqui. attemptNumber continua crescendo.
        await tx.conversion.update({
          where: { id: conversion.id },
          data: { status: "PENDING", failureReason: null, attemptBudgetBase: conversion.attemptCount },
        });
        await enqueue();
        conversionActions.push({ target: provider, action: "RESET_AND_ENQUEUED", reason: conversion.failureReason ?? undefined });
      }
    }

    await tx.reprocessRequest.update({
      where: { id: request.id },
      data: { summary: { events: eventActions, conversions: conversionActions } as unknown as Prisma.InputJsonValue },
    });

    return {
      requestId: request.id,
      orderId,
      requestedBy: operator,
      requestedAt: request.requestedAt,
      includePermanentFailures,
      events: eventActions,
      conversions: conversionActions,
    };
  });
}
