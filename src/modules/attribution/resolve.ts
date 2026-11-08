import {
  IDENTIFIER_FIELDS,
  canonicalJson,
  type IdentifierField,
  type Identifiers,
} from "../tracking/normalize.js";

/** Nível 2: identificadores próprios das ferramentas de tracking (ADR-001). */
export const PLATFORM_IDENTIFIER_FIELDS = ["utmifyId", "redtrackClickId"] as const satisfies readonly IdentifierField[];
/** Nível 3: identificadores de clique das redes de anúncios (ADR-001). */
export const CLICK_ID_FIELDS = ["fbclid", "fbc", "gclid", "gbraid", "wbraid", "ttclid"] as const satisfies readonly IdentifierField[];
/** Cookies de navegador compartilhados entre sessões. Nunca decidem a atribuição (ADR-013). */
export const BROWSER_COOKIE_FIELDS = ["fbp", "ttp"] as const satisfies readonly IdentifierField[];

export type CustomFieldsObject = Record<string, unknown>;

export interface SessionRecord {
  /** Chave interna (uuid). */
  id: string;
  sessionId: string;
  customFields: CustomFieldsObject | null;
  identifiers: Identifiers;
  customerEmail: string | null;
  firstSeenAt: Date;
}

/** Como o algoritmo enxerga o banco. Permite testá-lo com sessões em memória. */
export interface SessionLookup {
  findBySessionId(sessionId: string): Promise<SessionRecord | null>;
  findByIdentifier(field: IdentifierField, value: string): Promise<SessionRecord[]>;
  /** Sessões do cliente cujo `firstSeenAt` está em [from, to], ambos inclusivos. */
  findByCustomerEmail(email: string, from: Date, to: Date): Promise<SessionRecord[]>;
}

export interface AttributionEvidence {
  sessionId: string | null;
  identifiers: Identifiers;
  customerEmail: string | null;
  customFields: CustomFieldsObject | null;
  /** Instante imutável da primeira recepção (ADR-013). */
  receivedAt: Date;
}

export type AttributionLevel = 1 | 2 | 3 | 4;
export type DataSource = "WEBHOOK" | "SESSION";

export type UnattributedReason =
  | "NO_EVIDENCE"
  | "NO_MATCHING_SESSION"
  | "AMBIGUOUS_PLATFORM_IDENTIFIER"
  | "AMBIGUOUS_CLICK_ID"
  | "AMBIGUOUS_CUSTOMER_WINDOW";

export interface TraceStep {
  step: string;
  outcome: "ABSENT" | "NOT_FOUND" | "FOUND" | "AMBIGUOUS" | "NOT_USED";
  /** Nomes dos campos consultados. Nunca valores (podem ser dados pessoais). */
  fields?: string[];
  /** sessionIds candidatos. */
  candidates?: string[];
}

export type ConflictDetail =
  | { kind: "OTHER_SESSION_EVIDENCE"; level: AttributionLevel; method: string; sessionIds: string[] }
  | { kind: "IDENTIFIER_MISMATCH"; field: string }
  | { kind: "EMAIL_MISMATCH" };

export type Alert =
  | { code: "ATTRIBUTION_CONFLICT"; details: ConflictDetail[] }
  | { code: "CUSTOM_FIELDS_DIVERGENCE"; details: { used: DataSource } };

export interface Affiliate {
  code: string;
  source: DataSource;
  /** Nível da atribuição. `null` quando a venda não foi atribuída a uma sessão (ADR-018). */
  evidenceLevel: AttributionLevel | null;
}

export interface AttributionOutcome {
  result: "ATTRIBUTED" | "UNATTRIBUTED";
  level: AttributionLevel | null;
  method: string | null;
  /** Chave interna da sessão atribuída. */
  sessionRefId: string | null;
  sessionId: string | null;
  customFields: CustomFieldsObject | null;
  customFieldsSource: DataSource | "NONE";
  /** Identificadores efetivos, cada um com sua origem (ADR-021). Só os não nulos. */
  identifiers: Partial<Record<IdentifierField, { value: string; source: DataSource }>>;
  affiliate: Affiliate | null;
  alerts: Alert[];
  unattributedReason: UnattributedReason | null;
  trace: TraceStep[];
}

export interface ResolveOptions {
  windowHours: number;
}

interface LevelCandidates {
  level: AttributionLevel;
  method: string;
  ambiguousReason: UnattributedReason | null;
  sessions: SessionRecord[];
}

const present = (identifiers: Identifiers, fields: readonly IdentifierField[]) =>
  fields.filter((f) => identifiers[f] !== null);

async function gatherByIdentifiers(
  fields: readonly IdentifierField[],
  evidence: AttributionEvidence,
  lookup: SessionLookup,
): Promise<SessionRecord[]> {
  const found = new Map<string, SessionRecord>();
  for (const field of present(evidence.identifiers, fields)) {
    for (const session of await lookup.findByIdentifier(field, evidence.identifiers[field]!)) {
      found.set(session.id, session);
    }
  }
  return [...found.values()];
}

const nonEmpty = (value: CustomFieldsObject | null) => (value && Object.keys(value).length > 0 ? value : null);

/** Registra o que um nível encontrou: nada enviado, nenhuma sessão, uma sessão ou várias. */
function levelTrace(step: string, fields: string[], sessions: SessionRecord[]): TraceStep {
  const outcome =
    fields.length === 0 ? "ABSENT" : sessions.length === 0 ? "NOT_FOUND" : sessions.length === 1 ? "FOUND" : "AMBIGUOUS";
  return { step, fields, outcome, candidates: sessions.map((s) => s.sessionId) };
}

/**
 * Resolve a atribuição de uma venda (ADR-001, 003, 010, 011, 012, 013, 018, 020, 021).
 *
 * Duas fases: (1) reúne as evidências de TODOS os níveis; (2) decide. Assim, depois de escolher o
 * vencedor, dá para detectar conflito com as evidências dos outros níveis.
 *
 * Regras de decisão, em ordem de nível:
 * - uma única sessão candidata no nível: é a vencedora;
 * - mais de uma no mesmo nível: não atribui e PARA, sem cair para o nível seguinte (ADR-020);
 * - nenhuma: tenta o nível seguinte.
 */
export async function resolveAttribution(
  evidence: AttributionEvidence,
  lookup: SessionLookup,
  options: ResolveOptions,
): Promise<AttributionOutcome> {
  const trace: TraceStep[] = [];

  // Fase 1: evidências de todos os níveis.
  let bySessionId: SessionRecord | null = null;
  if (evidence.sessionId) {
    bySessionId = await lookup.findBySessionId(evidence.sessionId);
    trace.push({
      step: "LEVEL_1_SESSION_ID",
      outcome: bySessionId ? "FOUND" : "NOT_FOUND",
      candidates: bySessionId ? [bySessionId.sessionId] : [],
    });
  } else {
    trace.push({ step: "LEVEL_1_SESSION_ID", outcome: "ABSENT" });
  }

  const platform = await gatherByIdentifiers(PLATFORM_IDENTIFIER_FIELDS, evidence, lookup);
  const clicks = await gatherByIdentifiers(CLICK_ID_FIELDS, evidence, lookup);

  let byCustomer: SessionRecord[] = [];
  if (evidence.customerEmail) {
    const from = new Date(evidence.receivedAt.getTime() - options.windowHours * 3_600_000);
    byCustomer = await lookup.findByCustomerEmail(evidence.customerEmail, from, evidence.receivedAt);
  }

  const levels: LevelCandidates[] = [
    { level: 1, method: "SESSION_ID", ambiguousReason: null, sessions: bySessionId ? [bySessionId] : [] },
    { level: 2, method: "PLATFORM_IDENTIFIER", ambiguousReason: "AMBIGUOUS_PLATFORM_IDENTIFIER", sessions: platform },
    { level: 3, method: "CLICK_ID", ambiguousReason: "AMBIGUOUS_CLICK_ID", sessions: clicks },
    { level: 4, method: "CUSTOMER_WINDOW", ambiguousReason: "AMBIGUOUS_CUSTOMER_WINDOW", sessions: byCustomer },
  ];

  trace.push(levelTrace("LEVEL_2_PLATFORM_IDENTIFIER", present(evidence.identifiers, PLATFORM_IDENTIFIER_FIELDS), platform));
  trace.push(levelTrace("LEVEL_3_CLICK_ID", present(evidence.identifiers, CLICK_ID_FIELDS), clicks));
  trace.push(levelTrace("LEVEL_4_CUSTOMER_WINDOW", evidence.customerEmail ? ["customer.email"] : [], byCustomer));

  const cookies = present(evidence.identifiers, BROWSER_COOKIE_FIELDS);
  if (cookies.length > 0) trace.push({ step: "BROWSER_COOKIES", outcome: "NOT_USED", fields: cookies });

  // Fase 2: decisão.
  let winner: { level: AttributionLevel; method: string; session: SessionRecord } | null = null;
  let ambiguousReason: UnattributedReason | null = null;
  for (const candidate of levels) {
    if (candidate.sessions.length === 1) {
      winner = { level: candidate.level, method: candidate.method, session: candidate.sessions[0]! };
      break;
    }
    if (candidate.sessions.length > 1) {
      ambiguousReason = candidate.ambiguousReason;
      break;
    }
  }

  const alerts: Alert[] = [];
  const webhookCustomFields = nonEmpty(evidence.customFields);

  if (!winner) {
    const anyEvidence =
      evidence.sessionId !== null ||
      present(evidence.identifiers, [...PLATFORM_IDENTIFIER_FIELDS, ...CLICK_ID_FIELDS]).length > 0 ||
      evidence.customerEmail !== null;
    const reason: UnattributedReason = ambiguousReason ?? (anyEvidence ? "NO_MATCHING_SESSION" : "NO_EVIDENCE");

    // Sem sessão: usa o que o próprio webhook trouxe, sem inventar nada (ADR-011, ADR-021).
    return {
      result: "UNATTRIBUTED",
      level: null,
      method: null,
      sessionRefId: null,
      sessionId: null,
      customFields: webhookCustomFields,
      customFieldsSource: webhookCustomFields ? "WEBHOOK" : "NONE",
      identifiers: effectiveIdentifiers(evidence.identifiers, "WEBHOOK"),
      affiliate: affiliateFrom(webhookCustomFields, "WEBHOOK", null),
      alerts,
      unattributedReason: reason,
      trace,
    };
  }

  const { session } = winner;

  // Conflitos com as demais evidências (ADR-012, ADR-020). O vencedor permanece.
  const conflicts: ConflictDetail[] = [];
  for (const other of levels) {
    if (other.level === winner.level) continue;
    const different = other.sessions.filter((s) => s.id !== session.id);
    if (different.length > 0) {
      conflicts.push({
        kind: "OTHER_SESSION_EVIDENCE",
        level: other.level,
        method: other.method,
        sessionIds: different.map((s) => s.sessionId),
      });
    }
  }
  for (const field of IDENTIFIER_FIELDS) {
    const fromWebhook = evidence.identifiers[field];
    const fromSession = session.identifiers[field];
    if (fromWebhook && fromSession && fromWebhook !== fromSession) conflicts.push({ kind: "IDENTIFIER_MISMATCH", field });
  }
  if (evidence.customerEmail && session.customerEmail && evidence.customerEmail !== session.customerEmail) {
    conflicts.push({ kind: "EMAIL_MISMATCH" });
  }
  if (conflicts.length > 0) alerts.push({ code: "ATTRIBUTION_CONFLICT", details: conflicts });

  // customFields: objeto inteiro do webhook se houver, senão o da sessão. Sem mesclar chaves (ADR-011).
  const sessionCustomFields = nonEmpty(session.customFields);
  let customFields: CustomFieldsObject | null;
  let customFieldsSource: DataSource | "NONE";
  if (webhookCustomFields) {
    customFields = webhookCustomFields;
    customFieldsSource = "WEBHOOK";
    if (sessionCustomFields && canonicalJson(sessionCustomFields) !== canonicalJson(webhookCustomFields)) {
      alerts.push({ code: "CUSTOM_FIELDS_DIVERGENCE", details: { used: "WEBHOOK" } });
    }
  } else if (sessionCustomFields) {
    customFields = sessionCustomFields;
    customFieldsSource = "SESSION";
  } else {
    customFields = null;
    customFieldsSource = "NONE";
  }

  return {
    result: "ATTRIBUTED",
    level: winner.level,
    method: winner.method,
    sessionRefId: session.id,
    sessionId: session.sessionId,
    customFields,
    customFieldsSource,
    // Com sessão atribuída, só os identificadores da sessão (ADR-021).
    identifiers: effectiveIdentifiers(session.identifiers, "SESSION"),
    affiliate: affiliateFrom(customFields, customFieldsSource === "NONE" ? null : customFieldsSource, winner.level),
    alerts,
    unattributedReason: null,
    trace,
  };
}

function effectiveIdentifiers(identifiers: Identifiers, source: DataSource): AttributionOutcome["identifiers"] {
  const result: AttributionOutcome["identifiers"] = {};
  for (const field of IDENTIFIER_FIELDS) {
    const value = identifiers[field];
    if (value !== null) result[field] = { value, source };
  }
  return result;
}

/** Guarda o afiliado com origem e nível de evidência. Só texto não vazio conta (ADR-018). */
function affiliateFrom(
  customFields: CustomFieldsObject | null,
  source: DataSource | null,
  evidenceLevel: AttributionLevel | null,
): Affiliate | null {
  const raw = customFields?.["affiliateCode"];
  if (source === null || typeof raw !== "string" || raw.trim() === "") return null;
  return { code: raw.trim(), source, evidenceLevel };
}
