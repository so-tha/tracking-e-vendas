import { minorUnitsToDecimalString } from "../../shared/money.js";
import type { IdentifierField } from "../tracking/normalize.js";
import type { Affiliate, Alert, AttributionLevel, DataSource } from "../attribution/resolve.js";
import type { ConversionEvent } from "./types.js";

export interface EventInput {
  order: {
    orderId: string;
    amountMinor: bigint;
    currency: string;
    customerEmail: string | null;
    receivedAt: Date;
  };
  attribution: {
    result: "ATTRIBUTED" | "UNATTRIBUTED";
    level: AttributionLevel | null;
    sessionId: string | null;
    identifiers: Partial<Record<IdentifierField, { value: string; source: DataSource }>>;
    customFields: Record<string, unknown> | null;
    affiliate: Affiliate | null;
    alerts: Alert[];
  };
  /** Sessão atribuída, se houver. */
  session: { pageUrl: string; customerEmail: string | null; customerPhone: string | null } | null;
}

/** Níveis em que o afiliado pode ser enviado (ADR-018). */
const AFFILIATE_LEVELS: readonly number[] = [1, 2, 3];

/**
 * Monta o ConversionEvent congelado (ADR-036).
 *
 * Dados pessoais: o e-mail vem do webhook. Se faltar, e a venda foi atribuída a uma sessão SEM conflito,
 * completa-se com o da sessão. O telefone só vem da sessão, sob a mesma condição. Havendo
 * ATTRIBUTION_CONFLICT, nenhum dado pessoal da sessão é usado, porque podem ser pessoas diferentes.
 */
export function buildConversionEvent({ order, attribution, session }: EventInput): ConversionEvent {
  const hasConflict = attribution.alerts.some((alert) => alert.code === "ATTRIBUTION_CONFLICT");
  const sessionIsTrusted = session !== null && attribution.result === "ATTRIBUTED" && !hasConflict;

  const affiliate = attribution.affiliate;
  const affiliateAllowed =
    affiliate !== null && affiliate.evidenceLevel !== null && AFFILIATE_LEVELS.includes(affiliate.evidenceLevel);

  return {
    version: 1,
    eventId: order.orderId,
    orderId: order.orderId,
    eventName: "Purchase",
    occurredAt: order.receivedAt.toISOString(),
    amountMinor: order.amountMinor.toString(),
    currency: order.currency,
    amountDecimal: minorUnitsToDecimalString(order.amountMinor, order.currency),
    pageUrl: attribution.result === "ATTRIBUTED" && session ? session.pageUrl : null,
    attributionLevel: attribution.level,
    sessionId: attribution.sessionId,
    identifiers: attribution.identifiers,
    customFields: attribution.customFields,
    affiliateCode: affiliateAllowed ? affiliate.code : null,
    customer: {
      email: order.customerEmail ?? (sessionIsTrusted ? session.customerEmail : null),
      phone: sessionIsTrusted ? session.customerPhone : null,
    },
  };
}

export function parseConversionEvent(json: unknown): ConversionEvent {
  const event = json as ConversionEvent | null;
  if (!event || typeof event !== "object" || event.version !== 1) {
    throw new Error("eventSnapshot inválido ou de versão desconhecida");
  }
  return event;
}
