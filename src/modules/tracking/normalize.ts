import { z } from "zod";

export const IDENTIFIER_FIELDS = [
  "fbclid",
  "fbc",
  "fbp",
  "gclid",
  "gbraid",
  "wbraid",
  "ttclid",
  "ttp",
  "redtrackClickId",
  "utmifyId",
] as const;

export type IdentifierField = (typeof IDENTIFIER_FIELDS)[number];
export type Identifiers = Record<IdentifierField, string | null>;
export type CustomFields = Record<string, string | number | boolean | null>;

/** Identificadores diferenciam maiúsculas de minúsculas. Só removemos espaços nas pontas. */
export function normalizeIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function normalizeEmail(value: string | null | undefined): { value: string | null; invalid: boolean } {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (trimmed === "") return { value: null, invalid: false };
  return z.email().safeParse(trimmed).success
    ? { value: trimmed, invalid: false }
    : { value: null, invalid: true };
}

/**
 * Aceita apenas formato internacional (E.164): "+" e 8 a 15 dígitos, sem zero inicial.
 * Remove espaços, hífens, pontos e parênteses. Não adivinha o código do país.
 */
export function normalizePhone(value: string | null | undefined): { value: string | null; invalid: boolean } {
  const stripped = value?.replace(/[\s().-]/g, "") ?? "";
  if (stripped === "") return { value: null, invalid: false };
  return /^\+[1-9]\d{7,14}$/.test(stripped)
    ? { value: stripped, invalid: false }
    : { value: null, invalid: true };
}

/** `{}` e `null` significam "sem customFields" (ADR-022). */
export function normalizeCustomFields(value: CustomFields | null | undefined): CustomFields | null {
  if (!value || Object.keys(value).length === 0) return null;
  return value;
}

/** JSON com chaves ordenadas, para comparar objetos sem depender da ordem das chaves. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

export interface NormalizedSession {
  sessionId: string;
  pageUrl: string;
  customFields: CustomFields | null;
  identifiers: Identifiers;
  customerEmail: string | null;
  customerPhone: string | null;
  /** Campos ignorados por formato inválido (não derrubam a sessão). */
  warnings: string[];
}
