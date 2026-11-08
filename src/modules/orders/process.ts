import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../shared/db.js";
import { PermanentJobError } from "../../shared/jobRunner.js";
import type { ClaimedJob } from "../../shared/queue.js";
import { buildConversionEvent } from "../conversions/event.js";
import { createConversions } from "../conversions/create.js";
import type { ProviderRegistry } from "../conversions/providers/index.js";
import { createSessionLookup } from "../attribution/repository.js";
import { resolveAttribution, type AttributionEvidence, type AttributionOutcome } from "../attribution/resolve.js";
import { parseOrderPaid } from "./payload.js";

const jobPayloadSchema = z.object({ eventId: z.string().min(1) });

/** Chave do lock consultivo que serializa o processamento de eventos do mesmo pedido. */
export const orderLockKey = (orderId: string): string => `order:${orderId}`;

export interface ProcessOrderOptions {
  matchWindowHours: number;
  /** Adaptadores usados para decidir a elegibilidade das conversões. */
  providers: ProviderRegistry;
  /** Injetável para testes (ex.: simular falha na atribuição). */
  attribute?: typeof resolveAttribution;
}

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * Handler do job PROCESS_ORDER_EVENT. Cria o pedido, o snapshot de atribuição e as conversões (com seus
 * jobs de entrega) na mesma transação.
 * Idempotente: se o evento já foi tratado, não faz nada. O lock por orderId serializa eventos
 * simultâneos do mesmo pedido, e a constraint única de orderId é a rede de segurança.
 */
export function createProcessOrderEvent(prisma: PrismaClient, now: () => Date, options: ProcessOrderOptions) {
  const attribute = options.attribute ?? resolveAttribution;
  return async (job: ClaimedJob): Promise<void> => {
    const payload = jobPayloadSchema.safeParse(job.payload);
    if (!payload.success) throw new PermanentJobError("payload do job inválido");
    const { eventId } = payload.data;

    await prisma.$transaction(async (tx) => {
      const found = await tx.webhookEvent.findUnique({ where: { eventId } });
      if (!found) throw new PermanentJobError(`evento ${eventId} não encontrado`);

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orderLockKey(found.orderId)}, 0))`;

      // Relê depois do lock: outro worker pode ter tratado o evento enquanto esperávamos.
      const event = await tx.webhookEvent.findUniqueOrThrow({ where: { eventId } });
      if (event.status !== "RECEIVED") return;

      const parsed = parseOrderPaid(event.payload);
      if (!parsed.ok) throw new PermanentJobError(`payload do evento ${eventId} não é um ORDER_PAID válido`);
      const order = parsed.data;
      const processedAt = now();

      const existing = await tx.order.findUnique({ where: { orderId: event.orderId } });
      if (existing) {
        await tx.webhookEvent.update({
          where: { id: event.id },
          data: {
            status: "DUPLICATE_ORDER",
            statusReason: [event.statusReason, `pedido já criado pelo evento de id ${existing.webhookEventId}`]
              .filter(Boolean)
              .join("; "),
            processedAt,
          },
        });
        return;
      }

      const created = await tx.order.create({
        data: {
          orderId: event.orderId,
          webhookEventId: event.id,
          amountMinor: order.amountMinor,
          currency: order.currency,
          customerEmail: order.customerEmail,
          webhookSessionId: order.sessionId,
          receivedAt: event.receivedAt,
        },
      });

      // O snapshot nasce junto com o pedido e nunca mais é recalculado. Se a atribuição
      // falhar, a transação inteira é desfeita e o job é repetido.
      const evidence: AttributionEvidence = {
        sessionId: order.sessionId,
        identifiers: order.identifiers,
        customerEmail: order.customerEmail,
        customFields: order.customFields,
        receivedAt: event.receivedAt,
      };
      const outcome = await attribute(evidence, createSessionLookup(tx), { windowHours: options.matchWindowHours });
      await tx.attributionSnapshot.create({ data: snapshotData(created.id, outcome) });

      // As conversões nascem na mesma transação do pedido e do snapshot.
      const session = outcome.sessionRefId
        ? await tx.trackingSession.findUnique({ where: { id: outcome.sessionRefId } })
        : null;
      const conversionEvent = buildConversionEvent({
        order: created,
        attribution: outcome,
        session: session ? { pageUrl: session.pageUrl, customerEmail: session.customerEmail, customerPhone: session.customerPhone } : null,
      });
      await createConversions(tx, { orderRefId: created.id, event: conversionEvent, providers: options.providers, now: processedAt });

      await tx.webhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt } });
    });
  };
}

function snapshotData(orderRefId: string, outcome: AttributionOutcome): Prisma.AttributionSnapshotUncheckedCreateInput {
  return {
    orderRefId,
    result: outcome.result,
    level: outcome.level,
    method: outcome.method,
    sessionRefId: outcome.sessionRefId,
    customFields: outcome.customFields ? json(outcome.customFields) : undefined,
    customFieldsSource: outcome.customFieldsSource,
    identifiers: json(outcome.identifiers),
    affiliateCode: outcome.affiliate?.code ?? null,
    affiliateCodeSource: outcome.affiliate?.source ?? null,
    affiliateEvidenceLevel: outcome.affiliate?.evidenceLevel ?? null,
    alerts: json(outcome.alerts),
    unattributedReason: outcome.unattributedReason,
    decisionTrace: json(outcome.trace),
  };
}
