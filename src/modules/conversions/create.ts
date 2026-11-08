import type { Prisma } from "../../generated/prisma/client.js";
import { enqueueJob } from "../../shared/queue.js";
import type { ProviderRegistry } from "./providers/index.js";
import { PROVIDER_NAMES, type ConversionEvent } from "./types.js";

export const DELIVER_CONVERSION = "DELIVER_CONVERSION";

export interface CreateConversionsInput {
  orderRefId: string;
  event: ConversionEvent;
  providers: ProviderRegistry;
  now: Date;
}

/**
 * Cria uma Conversion por provedor, na transação do pedido (ADR-036).
 * - Elegível: nasce PENDING e ganha um job de entrega.
 * - Não elegível: nasce SKIPPED com o motivo, sem job e sem DeliveryAttempt (não houve tentativa).
 * A unicidade (pedido, provedor) é garantida pelo banco.
 */
export async function createConversions(
  tx: Prisma.TransactionClient,
  { orderRefId, event, providers, now }: CreateConversionsInput,
): Promise<{ pending: number; skipped: number }> {
  let pending = 0;
  let skipped = 0;

  for (const name of PROVIDER_NAMES) {
    const eligibility = providers[name].eligibility(event, now);

    const conversion = await tx.conversion.create({
      data: {
        orderRefId,
        provider: name,
        status: eligibility.eligible ? "PENDING" : "SKIPPED",
        skipReason: eligibility.eligible ? null : eligibility.reason,
        dedupKey: `${event.orderId}:${name}:ORDER_PAID`,
        eventSnapshot: event as unknown as Prisma.InputJsonValue,
      },
    });

    if (eligibility.eligible) {
      pending++;
      await enqueueJob(tx, {
        type: DELIVER_CONVERSION,
        payload: { conversionId: conversion.id },
        dedupKey: `deliver-conversion:${conversion.id}`,
        runAt: now,
      });
    } else {
      skipped++;
    }
  }
  return { pending, skipped };
}
