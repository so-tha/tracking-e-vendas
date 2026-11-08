import { z } from "zod";
import { isValidCurrency } from "../../shared/money.js";
import {
  IDENTIFIER_FIELDS,
  normalizeEmail,
  normalizeIdentifier,
  type IdentifierField,
} from "../tracking/normalize.js";

export const SUPPORTED_EVENT = "ORDER_PAID";

const envelopeSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  event: z.string().trim().min(1).max(100),
  orderId: z.string().trim().min(1).max(200),
});

const paidSchema = z.object({
  /** Menor unidade monetária da moeda. */
  amount: z.number().int().nonnegative(),
  currency: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine(isValidCurrency, "código de moeda ISO 4217 inválido"),
});

export type Envelope = z.infer<typeof envelopeSchema>;

export interface Issue {
  path: string;
  message: string;
}

const toIssues = (error: z.ZodError): Issue[] =>
  error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));

export type EnvelopeResult = { ok: true; data: Envelope } | { ok: false; issues: Issue[] };

/** Campos obrigatórios de qualquer evento. Sem eles não há como garantir idempotência. */
export function parseEnvelope(body: unknown): EnvelopeResult {
  const parsed = envelopeSchema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, issues: toIssues(parsed.error) };
}

export interface OrderPaid {
  eventId: string;
  orderId: string;
  amountMinor: bigint;
  currency: string;
  sessionId: string | null;
  customerEmail: string | null;
  /** Objeto inteiro enviado pelo webhook. `null` quando ausente ou vazio. */
  customFields: Record<string, unknown> | null;
  identifiers: Record<IdentifierField, string | null>;
  /** Campos opcionais ignorados por formato inválido. Nunca contêm valores. */
  warnings: string[];
}

export type OrderPaidResult = { ok: true; data: OrderPaid } | { ok: false; issues: Issue[] };

const sessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !/\s/.test(v) && !/[\u0000-\u001f\u007f]/.test(v));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * Só `eventId`, `event`, `orderId`, `amount` e `currency` são estritos. Perder uma venda paga por causa
 * de um campo opcional malformado seria pior do que ignorar o campo. O payload original
 * continua preservado integralmente no WebhookEvent.
 */
export function parseOrderPaid(body: unknown): OrderPaidResult {
  const envelope = parseEnvelope(body);
  if (!envelope.ok) return envelope;
  const paid = paidSchema.safeParse(body);
  if (!paid.success) return { ok: false, issues: toIssues(paid.error) };

  const raw = body as Record<string, unknown>;
  const warnings: string[] = [];

  let sessionId: string | null = null;
  if (isPresent(raw["sessionId"])) {
    const parsed = sessionIdSchema.safeParse(raw["sessionId"]);
    if (parsed.success) sessionId = parsed.data;
    else warnings.push("sessionId ignorado: formato inválido");
  }

  let customerEmail: string | null = null;
  const customer = raw["customer"];
  if (isPresent(customer)) {
    if (!isObject(customer)) {
      warnings.push("customer ignorado: formato inválido");
    } else if (isPresent(customer["email"])) {
      const email = typeof customer["email"] === "string" ? normalizeEmail(customer["email"]) : { value: null, invalid: true };
      customerEmail = email.value;
      if (email.invalid) warnings.push("customer.email ignorado: formato inválido");
    }
  }

  let customFields: Record<string, unknown> | null = null;
  const rawCustomFields = raw["customFields"];
  if (isPresent(rawCustomFields)) {
    if (isObject(rawCustomFields)) customFields = Object.keys(rawCustomFields).length > 0 ? rawCustomFields : null;
    else warnings.push("customFields ignorado: deve ser um objeto");
  }

  const identifiers = Object.fromEntries(IDENTIFIER_FIELDS.map((f) => [f, null])) as Record<IdentifierField, string | null>;
  const rawIdentifiers = raw["identifiers"];
  if (isPresent(rawIdentifiers)) {
    if (!isObject(rawIdentifiers)) {
      warnings.push("identifiers ignorado: deve ser um objeto");
    } else {
      for (const field of IDENTIFIER_FIELDS) {
        const value = rawIdentifiers[field];
        if (!isPresent(value)) continue;
        if (typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)) {
          identifiers[field] = normalizeIdentifier(value);
        } else {
          warnings.push(`identifiers.${field} ignorado: formato inválido`);
        }
      }
    }
  }

  return {
    ok: true,
    data: {
      eventId: envelope.data.eventId,
      orderId: envelope.data.orderId,
      amountMinor: BigInt(paid.data.amount),
      currency: paid.data.currency,
      sessionId,
      customerEmail,
      customFields,
      identifiers,
      warnings,
    },
  };
}
