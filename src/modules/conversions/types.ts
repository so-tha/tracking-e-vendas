import type { IdentifierField } from "../tracking/normalize.js";

export const PROVIDER_NAMES = ["META", "GOOGLE", "TIKTOK", "UTMIFY", "REDTRACK"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type DataSource = "WEBHOOK" | "SESSION";

/**
 * Evento de conversão congelado (ADR-036). É gravado em Conversion.eventSnapshot e usado em todas as
 * tentativas, então o payload enviado não muda mesmo que a sessão receba dados novos depois.
 */
export interface ConversionEvent {
  version: 1;
  /** Igual ao orderId: o checkout precisa usar o mesmo valor como eventID do Pixel para deduplicar (ADR-037). */
  eventId: string;
  orderId: string;
  eventName: "Purchase";
  /** ISO 8601 em UTC. Instante do recebimento do evento (a data real do pedido não vem no webhook). */
  occurredAt: string;
  /** Menor unidade monetária, como texto (BigInt não é JSON). */
  amountMinor: string;
  currency: string;
  /** Valor decimal calculado sem ponto flutuante (ADR-017). Ex.: "255.00". */
  amountDecimal: string;
  pageUrl: string | null;
  attributionLevel: 1 | 2 | 3 | 4 | null;
  sessionId: string | null;
  /** Identificadores efetivos com a origem de cada um (ADR-021). */
  identifiers: Partial<Record<IdentifierField, { value: string; source: DataSource }>>;
  customFields: Record<string, unknown> | null;
  /** Já restrito aos níveis 1 a 3 (ADR-018). Nulo nos demais casos. */
  affiliateCode: string | null;
  /** Dados já validados e normalizados, em claro. O hash é responsabilidade de cada adaptador (ADR-038). */
  customer: { email: string | null; phone: string | null };
}

export interface HttpRequest {
  method: "GET" | "POST";
  /** URL sem segredos. Pode conter a query string não sensível (ex.: o postback do RedTrack). */
  url: string;
  /** Pode conter credenciais. Nunca é gravado na auditoria. */
  headers: Record<string, string>;
  /** Parâmetros de query secretos (ex.: access_token da Meta). Nunca gravados na auditoria. */
  secretQuery?: Record<string, string>;
  body?: unknown;
}

/** O que é gravado em DeliveryAttempt.requestPayload: o request sem cabeçalhos nem segredos. */
export interface AuditedRequest {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** Falha de rede ou timeout. Sempre transitória. */
export class TransportError extends Error {
  constructor(
    public readonly kind: "timeout" | "network",
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

/** O evento não consegue ser convertido para o contrato do provedor. Não adianta tentar de novo. */
export class ContractError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ContractError";
  }
}

export type Outcome = "SUCCESS" | "TRANSIENT" | "PERMANENT";

export interface SendResult {
  request: AuditedRequest;
  httpStatus: number | null;
  responseBody: unknown;
  outcome: Outcome;
  error: string | null;
  /** Valor do cabeçalho Retry-After, em milissegundos. */
  retryAfterMs: number | null;
}

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/** Contrato de um adaptador de provedor (documento original, seção 6, com os métodos puros do ADR-036). */
export interface ConversionProvider {
  readonly name: ProviderName;
  /** Requisitos mínimos do provedor. Pura. Quando não atendidos, a conversão nasce SKIPPED. */
  eligibility(event: ConversionEvent, now: Date): Eligibility;
  /** Monta o request do contrato do provedor. Pura. Pode lançar ContractError. */
  buildRequest(event: ConversionEvent): HttpRequest;
  /** Envia. Não lança para falhas do provedor ou de rede: devolve o resultado classificado. */
  send(event: ConversionEvent): Promise<SendResult>;
}

export const identifierValue = (event: ConversionEvent, field: IdentifierField): string | null =>
  event.identifiers[field]?.value ?? null;

export const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;

export const isOlderThanSevenDays = (event: ConversionEvent, now: Date): boolean =>
  now.getTime() - new Date(event.occurredAt).getTime() > SEVEN_DAYS_MS;
