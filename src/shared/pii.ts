import { createHash } from "node:crypto";

/**
 * Normalização e hash de dados pessoais enviados a provedores (ADR-038).
 * O hash é SHA-256 dos bytes UTF-8 do texto JÁ normalizado, em hexadecimal minúsculo (64 caracteres).
 * Cada provedor normaliza de um jeito, então a normalização é uma função separada por regra.
 */
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const E164 = /^\+[1-9]\d{7,14}$/;

export const isE164 = (value: string): boolean => E164.test(value);

/** Regra comum: sem espaços nas pontas e em minúsculas (Meta, TikTok e a base do Google). */
export function normalizeEmailBasic(email: string): string | null {
  const basic = email.trim().toLowerCase();
  return basic.includes("@") && basic.indexOf("@") > 0 ? basic : null;
}

/**
 * Regra do Google: a básica e, só para gmail.com e googlemail.com, remove os pontos do usuário
 * e o primeiro "+" com tudo que vem depois dele, até o "@".
 */
export function normalizeEmailGoogle(email: string): string | null {
  const basic = normalizeEmailBasic(email);
  if (!basic) return null;
  const at = basic.lastIndexOf("@");
  let local = basic.slice(0, at);
  const domain = basic.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
  }
  return local === "" || domain === "" ? null : `${local}@${domain}`;
}

/** Regra da Meta: só dígitos, com código do país, sem "+", sem símbolos e sem zeros à esquerda. */
export function normalizePhoneMeta(e164: string): string | null {
  if (!isE164(e164)) return null;
  const digits = e164.slice(1).replace(/^0+/, "");
  return digits === "" ? null : digits;
}

/** Regra do Google e do TikTok: E.164 com "+". */
export function normalizePhoneE164(value: string): string | null {
  return isE164(value) ? value : null;
}

/** Hash de um valor já normalizado. Valor ausente nunca é hasheado. */
export const hashOrNull = (normalized: string | null): string | null => (normalized ? sha256Hex(normalized) : null);

export const isSha256Hex = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Máscara para exibição (ADR-019): c***@email.com e ******9999. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at <= 0 ? "***" : `${email[0]}***${email.slice(at)}`;
}

export function maskPhone(phone: string): string {
  return phone.length <= 4 ? "***" : `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}
