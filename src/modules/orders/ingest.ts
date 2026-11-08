import type { Prisma } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../shared/db.js";
import { enqueueJob } from "../../shared/queue.js";
import { canonicalJson } from "../tracking/normalize.js";
import { SUPPORTED_EVENT, parseEnvelope, parseOrderPaid, type Issue } from "./payload.js";

export const PROCESS_ORDER_EVENT = "PROCESS_ORDER_EVENT";

export type IngestOutcome =
  | { kind: "invalid"; issues: Issue[] }
  | { kind: "queued"; eventId: string; warnings: string[] }
  | { kind: "ignored"; eventId: string; warnings: string[] }
  | { kind: "duplicate"; eventId: string; payloadDiffers: boolean };

/**
 * Recebe o webhook:
 * - grava o evento com o payload original e, se for ORDER_PAID, o job, na MESMA transação;
 * - o mesmo eventId nunca grava duas vezes (constraint única, INSERT ... ON CONFLICT DO NOTHING);
 * - eventos de outros tipos são registrados e ignorados.
 */
export async function ingestWebhook(prisma: PrismaClient, body: unknown, now: Date): Promise<IngestOutcome> {
  const envelope = parseEnvelope(body);
  if (!envelope.ok) return { kind: "invalid", issues: envelope.issues };

  const supported = envelope.data.event === SUPPORTED_EVENT;
  let warnings: string[] = [];
  if (supported) {
    const paid = parseOrderPaid(body);
    if (!paid.ok) return { kind: "invalid", issues: paid.issues };
    warnings = paid.data.warnings;
  }

  const { eventId, event, orderId } = envelope.data;

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.webhookEvent.createMany({
      data: [
        {
          eventId,
          eventType: event,
          orderId,
          payload: body as Prisma.InputJsonValue,
          receivedAt: now,
          status: supported ? "RECEIVED" : "IGNORED_UNSUPPORTED",
          statusReason: supported
            ? warnings.length > 0 ? warnings.join("; ") : null
            : `evento ${event} não é processado`,
          processedAt: supported ? null : now,
        },
      ],
      skipDuplicates: true,
    });

    if (count === 0) {
      const existing = await tx.webhookEvent.findUniqueOrThrow({ where: { eventId } });
      return {
        kind: "duplicate",
        eventId,
        payloadDiffers: canonicalJson(existing.payload) !== canonicalJson(body),
      } as const;
    }

    if (!supported) return { kind: "ignored", eventId, warnings } as const;

    await enqueueJob(tx, {
      type: PROCESS_ORDER_EVENT,
      payload: { eventId },
      dedupKey: `process-order-event:${eventId}`,
      runAt: now,
    });
    return { kind: "queued", eventId, warnings } as const;
  });
}
