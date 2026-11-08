import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../shared/db.js";
import { PermanentJobError, type JobHandler } from "../../shared/jobRunner.js";
import { computeBackoffMs } from "../../shared/retry.js";
import { parseConversionEvent } from "./event.js";
import { toAudited } from "./http.js";
import type { ProviderRegistry } from "./providers/index.js";
import { ContractError, type SendResult } from "./types.js";

const payloadSchema = z.object({ conversionId: z.string().min(1) });

export interface DeliverOptions {
  providers: ProviderRegistry;
  /** Total de tentativas por conversão (CONVERSION_MAX_ATTEMPTS). */
  maxAttempts: number;
  retryBaseMs: number;
  random?: () => number;
}

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * Handler do job DELIVER_CONVERSION (ADR-036).
 *
 * - Só envia se a conversão está PENDING: DELIVERED, SKIPPED e FAILED_PERMANENT nunca são reenviadas.
 * - O payload é reconstruído do evento congelado, então reprocessar não muda o que é enviado.
 * - A chamada ao provedor acontece FORA da transação do banco.
 * - Cada tentativa grava status, HTTP, datas, erro, número e o request efetivamente enviado.
 * - Só falha transitória gera nova tentativa, com backoff, até maxAttempts. Erro permanente não repete.
 * - Cada conversão é um job independente, então um provedor com problema não afeta os outros.
 */
export function createDeliverConversion(prisma: PrismaClient, now: () => Date, options: DeliverOptions): JobHandler {
  return async (job) => {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) throw new PermanentJobError("payload do job inválido");
    const { conversionId } = parsed.data;

    const conversion = await prisma.conversion.findUnique({ where: { id: conversionId } });
    if (!conversion) throw new PermanentJobError(`conversão ${conversionId} não encontrada`);
    if (conversion.status !== "PENDING") return;

    const event = parseConversionEvent(conversion.eventSnapshot);
    const provider = options.providers[conversion.provider];

    // A idade do evento pode estourar durante os retries (Meta e UTMify, 7 dias).
    const eligibility = provider.eligibility(event, now());
    if (!eligibility.eligible) {
      const reason = eligibility.reason;
      await prisma.conversion.updateMany({
        where: { id: conversion.id, status: "PENDING" },
        data:
          conversion.attemptCount === 0
            ? { status: "SKIPPED", skipReason: reason }
            : { status: "FAILED_PERMANENT", failureReason: reason },
      });
      return;
    }

    const attemptNumber = conversion.attemptCount + 1;
    const startedAt = now();

    let result: SendResult;
    try {
      result = await provider.send(event);
    } catch (error) {
      if (error instanceof ContractError) {
        // O evento não cabe no contrato do provedor. Repetir não resolve, e nada foi enviado.
        await prisma.conversion.updateMany({
          where: { id: conversion.id, status: "PENDING" },
          data: { status: "FAILED_PERMANENT", failureReason: `CONTRACT_ERROR:${error.code}` },
        });
        return;
      }
      // Bug inesperado no adaptador: tratado como falha transitória e limitado por maxAttempts.
      result = {
        request: safeAuditedRequest(provider, event),
        httpStatus: null,
        responseBody: null,
        outcome: "TRANSIENT",
        error: `UNEXPECTED_ADAPTER_ERROR: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
        retryAfterMs: null,
      };
    }
    const finishedAt = now();

    // Grava a tentativa e o novo estado. O lock por conversão serializa execuções duplicadas do mesmo job.
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`conversion:${conversion.id}`}, 0))`;
      const fresh = await tx.conversion.findUniqueOrThrow({ where: { id: conversion.id } });
      // Outra execução já registrou esta tentativa (ou a conversão já terminou): não grava de novo.
      if (fresh.status !== "PENDING" || fresh.attemptCount !== conversion.attemptCount) return;

      await tx.deliveryAttempt.create({
        data: {
          conversionRefId: conversion.id,
          attemptNumber,
          status:
            result.outcome === "SUCCESS" ? "SUCCESS" : result.outcome === "TRANSIENT" ? "TRANSIENT_FAILURE" : "PERMANENT_FAILURE",
          httpStatus: result.httpStatus,
          requestPayload: json(result.request),
          responseBody: result.responseBody === null || result.responseBody === undefined ? undefined : json(result.responseBody),
          error: result.error,
          startedAt,
          finishedAt,
        },
      });

      const common = { attemptCount: attemptNumber, lastPayload: json(result.request) };

      if (result.outcome === "SUCCESS") {
        await tx.conversion.update({ where: { id: conversion.id }, data: { ...common, status: "DELIVERED", deliveredAt: finishedAt } });
        return;
      }

      if (result.outcome === "PERMANENT") {
        await tx.conversion.update({
          where: { id: conversion.id },
          data: { ...common, status: "FAILED_PERMANENT", failureReason: `PROVIDER_REJECTED:${result.httpStatus ?? "n/a"}` },
        });
        return;
      }

      // Transitória.
      // O orçamento conta as tentativas desde o último reinício solicitado (ADR-040).
      if (attemptNumber - fresh.attemptBudgetBase >= options.maxAttempts) {
        await tx.conversion.update({
          where: { id: conversion.id },
          data: { ...common, status: "FAILED_PERMANENT", failureReason: "RETRIES_EXHAUSTED" },
        });
        return;
      }

      await tx.conversion.update({ where: { id: conversion.id }, data: common });
      const backoff = computeBackoffMs({ attempt: attemptNumber, baseMs: options.retryBaseMs, random: options.random });
      const delay = Math.max(backoff, result.retryAfterMs ?? 0);
      return {
        retryAt: new Date(now().getTime() + delay),
        reason: `${conversion.provider} tentativa ${attemptNumber}: ${result.error ?? "falha transitória"}`,
      };
    });
  };
}

function safeAuditedRequest(provider: ProviderRegistry[keyof ProviderRegistry], event: ReturnType<typeof parseConversionEvent>) {
  try {
    return toAudited(provider.buildRequest(event));
  } catch {
    return { method: "POST" as const, url: "(request indisponível)" };
  }
}
