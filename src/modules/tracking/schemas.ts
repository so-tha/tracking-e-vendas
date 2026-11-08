import { z } from "zod";
import {
  IDENTIFIER_FIELDS,
  normalizeCustomFields,
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
  type Identifiers,
  type NormalizedSession,
} from "./normalize.js";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const identifier = z
  .string()
  .max(512)
  .refine((v) => !CONTROL_CHARS.test(v), "caracteres de controle não são permitidos")
  .nullish();

const identifiersShape = Object.fromEntries(IDENTIFIER_FIELDS.map((f) => [f, identifier])) as Record<
  (typeof IDENTIFIER_FIELDS)[number],
  typeof identifier
>;

const customFieldValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

const customFields = z
  // O Zod 4 descarta a chave "__proto__" ao validar registros, o que impede poluição de protótipo.
  .record(z.string().min(1).max(100), customFieldValue)
  .refine((o) => Object.keys(o).length <= 50, "no máximo 50 campos")
  .nullish();

const pageUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "deve ser uma URL http ou https válida");

const sessionId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !/\s/.test(v) && !CONTROL_CHARS.test(v), "não pode conter espaços ou caracteres de controle");

export const sessionRequestSchema = z.object({
  sessionId,
  pageUrl,
  customFields,
  identifiers: z.object(identifiersShape).nullish(),
  customer: z
    .object({ email: z.string().max(320).nullish(), phone: z.string().max(40).nullish() })
    .nullish(),
});

export type SessionRequest = z.infer<typeof sessionRequestSchema>;

export function normalizeSessionRequest(request: SessionRequest): NormalizedSession {
  const identifiers = Object.fromEntries(
    IDENTIFIER_FIELDS.map((field) => [field, normalizeIdentifier(request.identifiers?.[field])]),
  ) as Identifiers;

  const email = normalizeEmail(request.customer?.email);
  const phone = normalizePhone(request.customer?.phone);
  const warnings: string[] = [];
  if (email.invalid) warnings.push("customer.email ignorado: formato inválido");
  if (phone.invalid) warnings.push("customer.phone ignorado: use o formato internacional, por exemplo +5511999999999");

  return {
    sessionId: request.sessionId,
    pageUrl: request.pageUrl,
    customFields: normalizeCustomFields(request.customFields),
    identifiers,
    customerEmail: email.value,
    customerPhone: phone.value,
    warnings,
  };
}
