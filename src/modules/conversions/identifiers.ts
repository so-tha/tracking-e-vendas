import type { IdentifierField } from "../tracking/normalize.js";
import type { ProviderName } from "./types.js";

/**
 * Identificadores que cada provedor usa (ADR-037). O suporte mostra, para cada conversão, o valor
 * associado a esses campos e de onde ele veio. Um teste garante que isto fica consistente com a
 * elegibilidade de cada adaptador.
 */
export const PROVIDER_IDENTIFIER_FIELDS: Record<ProviderName, readonly IdentifierField[]> = {
  META: ["fbc", "fbp"],
  GOOGLE: ["gclid", "gbraid", "wbraid"],
  TIKTOK: ["ttclid", "ttp"],
  UTMIFY: ["utmifyId"],
  REDTRACK: ["redtrackClickId"],
};
