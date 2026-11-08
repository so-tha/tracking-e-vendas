import type { PrismaClient } from "../../generated/prisma/client.js";
import { minorUnitsToDecimalString } from "../../shared/money.js";
import { maskEmail, maskPhone } from "../../shared/pii.js";
import { DELIVER_CONVERSION } from "../conversions/create.js";
import { parseConversionEvent } from "../conversions/event.js";
import { PROVIDER_IDENTIFIER_FIELDS } from "../conversions/identifiers.js";
import { PROVIDER_NAMES, type ProviderName } from "../conversions/types.js";
import type { Alert } from "../attribution/resolve.js";
import { explainAlert, explainAttribution, explainConversion, explainEventStatus, explainUnattributed } from "./explain.js";
import { maskDeep } from "./mask.js";

/** Visão de diagnóstico de um pedido. Sem payload bruto do webhook e sem dados pessoais em claro. */
export async function loadTrackingView(prisma: PrismaClient, orderId: string): Promise<Record<string, unknown> | null> {
  const [order, events] = await Promise.all([
    prisma.order.findUnique({
      where: { orderId },
      include: {
        attribution: true,
        conversions: { include: { attempts: { orderBy: { attemptNumber: "asc" } } } },
      },
    }),
    prisma.webhookEvent.findMany({ where: { orderId }, orderBy: { receivedAt: "asc" } }),
  ]);
  if (!order && events.length === 0) return null;

  const eventViews = events.map((e) => ({
    eventId: e.eventId,
    eventType: e.eventType,
    status: e.status,
    explanation: explainEventStatus(e.status),
    statusReason: e.statusReason,
    receivedAt: e.receivedAt,
    processedAt: e.processedAt,
  }));

  const reprocessRequests = await prisma.reprocessRequest.findMany({ where: { orderId }, orderBy: { requestedAt: "asc" } });
  const reprocessViews = reprocessRequests.map((r) => ({
    requestId: r.id,
    requestedBy: r.requestedBy,
    requestedAt: r.requestedAt,
    includePermanentFailures: r.includePermanentFailures,
    summary: r.summary,
  }));

  if (!order) {
    return { orderId, order: null, events: eventViews, attribution: null, trackingData: null, conversions: [], reprocessRequests: reprocessViews };
  }

  const snapshot = order.attribution;
  const session = snapshot?.sessionRefId
    ? await prisma.trackingSession.findUnique({
        where: { id: snapshot.sessionRefId },
        include: { revisions: { orderBy: { receivedAt: "asc" } } },
      })
    : null;

  // Próxima tentativa de cada conversão: o job de entrega ainda ativo (inclui os criados por reprocessamento).
  const activeJobs = order.conversions.length
    ? await prisma.job.findMany({
        where: {
          type: DELIVER_CONVERSION,
          status: { in: ["PENDING", "RUNNING"] },
          OR: order.conversions.map((c) => ({ dedupKey: { startsWith: `deliver-conversion:${c.id}` } })),
        },
      })
    : [];
  const nextAttempt = (conversionId: string): Date | null => {
    const dates = activeJobs.filter((j) => j.dedupKey.startsWith(`deliver-conversion:${conversionId}`)).map((j) => j.runAt);
    return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
  };

  const byProvider = Object.fromEntries(order.conversions.map((c) => [c.provider, c])) as Partial<Record<ProviderName, (typeof order.conversions)[number]>>;
  const conversions = PROVIDER_NAMES.flatMap((provider) => {
    const c = byProvider[provider];
    if (!c) return [];
    const next = c.status === "PENDING" ? nextAttempt(c.id) : null;

    return [
      {
        provider,
        status: c.status,
        explanation: explainConversion({ ...c, nextAttemptAt: next }),
        skipReason: c.skipReason,
        failureReason: c.failureReason,
        attemptCount: c.attemptCount,
        deliveredAt: c.deliveredAt,
        nextAttemptAt: next,
        identifiers: identifiersUsed(provider, c.eventSnapshot),
        sentPayload: maskDeep(c.lastPayload),
        attempts: c.attempts.map((a) => ({
          attemptNumber: a.attemptNumber,
          status: a.status,
          httpStatus: a.httpStatus,
          error: a.error,
          startedAt: a.startedAt,
          finishedAt: a.finishedAt,
          request: maskDeep(a.requestPayload),
          response: maskDeep(a.responseBody),
        })),
      },
    ];
  });

  const alerts = (snapshot?.alerts ?? []) as unknown as Alert[];
  const identifiersMap = (snapshot?.identifiers ?? {}) as Record<string, { value: string; source: string }>;

  const affiliateLevel = snapshot?.affiliateEvidenceLevel ?? null;
  const sentToProviders = affiliateLevel !== null && affiliateLevel >= 1 && affiliateLevel <= 3;

  const sessionConflicts = (session?.revisions ?? []).flatMap((revision) =>
    ((revision.conflicts ?? []) as { field: string; kept: unknown; received: unknown }[]).map((conflict) => ({
      field: conflict.field,
      receivedAt: revision.receivedAt,
      kept: maskConflictValue(conflict.field, conflict.kept),
      received: maskConflictValue(conflict.field, conflict.received),
    })),
  );

  return {
    orderId,
    order: {
      amountMinor: order.amountMinor.toString(),
      currency: order.currency,
      amountDecimal: minorUnitsToDecimalString(order.amountMinor, order.currency),
      receivedAt: order.receivedAt,
      customerEmail: order.customerEmail ? maskEmail(order.customerEmail) : null,
      webhookSessionId: order.webhookSessionId,
    },
    events: eventViews,
    attribution: snapshot
      ? {
          result: snapshot.result,
          level: snapshot.level,
          method: snapshot.method,
          explanation:
            snapshot.result === "ATTRIBUTED"
              ? explainAttribution(snapshot.level, snapshot.method)
              : explainUnattributed(snapshot.unattributedReason),
          unattributedReason: snapshot.unattributedReason,
          alerts: alerts.map(explainAlert),
          decisionTrace: snapshot.decisionTrace,
          createdAt: snapshot.createdAt,
          session: session
            ? {
                sessionId: session.sessionId,
                pageUrl: session.pageUrl,
                firstSeenAt: session.firstSeenAt,
                lastSeenAt: session.lastSeenAt,
                revisions: session.revisions.length,
                conflicts: sessionConflicts,
              }
            : null,
        }
      : null,
    trackingData: snapshot
      ? {
          customFields: { value: maskDeep(snapshot.customFields), source: snapshot.customFieldsSource },
          identifiers: identifiersMap,
          affiliate: snapshot.affiliateCode
            ? {
                code: snapshot.affiliateCode,
                source: snapshot.affiliateCodeSource,
                evidenceLevel: affiliateLevel,
                sentToProviders,
                explanation: sentToProviders
                  ? "O afiliado pode ser enviado aos provedores que têm campo para ele (atribuição pelos níveis 1 a 3)."
                  : "O afiliado foi registrado, mas NÃO é enviado a nenhum provedor, porque a atribuição não foi pelos níveis 1 a 3.",
              }
            : null,
        }
      : null,
    conversions,
    reprocessRequests: reprocessViews,
  };
}

/** Que valor foi associado a cada identificador que este provedor usa, e de onde ele veio (evento congelado). */
function identifiersUsed(provider: ProviderName, eventSnapshot: unknown): { field: string; value: string; source: string }[] {
  if (!eventSnapshot) return [];
  const event = parseConversionEvent(eventSnapshot);
  return PROVIDER_IDENTIFIER_FIELDS[provider].flatMap((field) => {
    const found = event.identifiers[field];
    return found ? [{ field, value: found.value, source: found.source }] : [];
  });
}

/** Conflitos de e-mail e telefone da sessão mostram o valor mascarado. Os demais passam pela máscara geral. */
function maskConflictValue(field: string, value: unknown): unknown {
  if (typeof value === "string" && field === "customer.email") return maskEmail(value);
  if (typeof value === "string" && field === "customer.phone") return maskPhone(value);
  return maskDeep(value);
}
