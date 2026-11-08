import {
  IDENTIFIER_FIELDS,
  canonicalJson,
  type CustomFields,
  type Identifiers,
} from "./normalize.js";

export interface SessionState {
  pageUrl: string;
  customFields: CustomFields | null;
  identifiers: Identifiers;
  customerEmail: string | null;
  customerPhone: string | null;
}

export interface Change {
  field: string;
  value: unknown;
}

export interface Conflict {
  field: string;
  kept: unknown;
  received: unknown;
}

export interface MergeResult {
  next: SessionState;
  /** Campos que estavam vazios e foram complementados. */
  changes: Change[];
  /** Valores divergentes de campos já preenchidos. O valor original é preservado. */
  conflicts: Conflict[];
}

/**
 * 
 * - identificadores, e-mail e telefone: complementa se vazio. Se preenchido e diferente, registra conflito.
 * - customFields: objeto atômico. Preenchido uma vez, nunca é completado chave a chave.
 * - pageUrl: a primeira URL é preservada. Novas URLs ficam apenas no histórico de revisões.
 * - valor nulo recebido nunca apaga valor existente.
 */
export function mergeSession(existing: SessionState, incoming: SessionState): MergeResult {
  const changes: Change[] = [];
  const conflicts: Conflict[] = [];

  const mergeScalar = (field: string, kept: string | null, received: string | null): string | null => {
    if (received === null) return kept;
    if (kept === null) {
      changes.push({ field, value: received });
      return received;
    }
    if (kept !== received) conflicts.push({ field, kept, received });
    return kept;
  };

  const identifiers = { ...existing.identifiers };
  for (const field of IDENTIFIER_FIELDS) {
    identifiers[field] = mergeScalar(`identifiers.${field}`, existing.identifiers[field], incoming.identifiers[field]);
  }

  const customerEmail = mergeScalar("customer.email", existing.customerEmail, incoming.customerEmail);
  const customerPhone = mergeScalar("customer.phone", existing.customerPhone, incoming.customerPhone);

  let customFields = existing.customFields;
  if (incoming.customFields !== null) {
    if (existing.customFields === null) {
      changes.push({ field: "customFields", value: incoming.customFields });
      customFields = incoming.customFields;
    } else if (canonicalJson(existing.customFields) !== canonicalJson(incoming.customFields)) {
      conflicts.push({ field: "customFields", kept: existing.customFields, received: incoming.customFields });
    }
  }

  return {
    next: { pageUrl: existing.pageUrl, customFields, identifiers, customerEmail, customerPhone },
    changes,
    conflicts,
  };
}
