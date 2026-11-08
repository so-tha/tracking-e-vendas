import { maskEmail, maskPhone } from "../../shared/pii.js";

const HASH = /^[a-f0-9]{64}$/;

const maskName = (value: string): string => (value === "" ? value : `${value[0]}***`);
const maskAll = (): string => "***";

/** Chaves que carregam dados pessoais, em minúsculas. O valor depende da chave. */
const MASKERS: Record<string, (value: string) => string> = {
  email: maskEmail,
  customeremail: maskEmail,
  phone: maskPhone,
  customerphone: maskPhone,
  phone_number: maskPhone,
  document: maskAll,
  name: maskName,
  ip: maskAll,
  client_ip_address: maskAll,
};

/**
 * Máscara de dados pessoais para tudo que o suporte enxerga. Percorre qualquer JSON.
 * Valores que já são hash SHA-256 ficam como estão: o hash é a prova do que foi enviado ao provedor.
 * Não altera o objeto original.
 */
export function maskDeep(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    const masker = MASKERS[key.toLowerCase()];
    return masker && !HASH.test(value) ? masker(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v, k)]));
  }
  return value;
}
