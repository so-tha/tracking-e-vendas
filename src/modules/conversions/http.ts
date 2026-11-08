import {
  ContractError,
  TransportError,
  type AuditedRequest,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type SendResult,
} from "./types.js";

const MAX_RETRY_AFTER_MS = 3_600_000;

/** Classificação comum de status HTTP (ADR-036). Cada adaptador pode refinar o resultado. */
export function classifyHttp(response: HttpResponse): Pick<SendResult, "outcome" | "error" | "retryAfterMs"> {
  const { status } = response;
  if (status >= 200 && status < 300) return { outcome: "SUCCESS", error: null, retryAfterMs: null };

  const transient = status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  const retryAfter = transient ? parseRetryAfter(response.headers) : null;
  return {
    outcome: transient ? "TRANSIENT" : "PERMANENT",
    error: `HTTP ${status}`,
    retryAfterMs: retryAfter,
  };
}

function parseRetryAfter(headers: Record<string, string>): number | null {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after");
  if (!entry) return null;
  const seconds = Number(entry[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** Tira cabeçalhos e segredos: é o que vai para a auditoria (ADR-036). */
export const toAudited = (request: HttpRequest): AuditedRequest => {
  const audited: AuditedRequest = { method: request.method, url: request.url };
  if (request.body !== undefined) audited.body = request.body;
  return audited;
};

export type Refine = (
  response: HttpResponse,
  base: Pick<SendResult, "outcome" | "error" | "retryAfterMs">,
) => Pick<SendResult, "outcome" | "error" | "retryAfterMs">;

/**
 * Envia e classifica. Falha de rede vira TRANSIENT. Outros erros (bugs) são relançados
 * e tratados pelo motor de entrega como falha transitória do adaptador.
 */
export async function executeSend(request: HttpRequest, transport: HttpTransport, refine?: Refine): Promise<SendResult> {
  const audited = toAudited(request);
  try {
    const response = await transport.request(request);
    const base = classifyHttp(response);
    const result = refine ? refine(response, base) : base;
    return { request: audited, httpStatus: response.status, responseBody: response.body, ...result };
  } catch (error) {
    if (error instanceof TransportError) {
      return {
        request: audited,
        httpStatus: null,
        responseBody: null,
        outcome: "TRANSIENT",
        error: `${error.kind}: ${error.message}`,
        retryAfterMs: null,
      };
    }
    throw error;
  }
}

/**
 * Converte o valor decimal (texto) em número JSON sem perder precisão silenciosamente.
 * Se o número não representar exatamente o texto, o evento não pode ser enviado.
 */
export function decimalToNumber(decimal: string): number {
  const number = Number(decimal);
  const normalized = decimal.includes(".") ? decimal.replace(/\.?0+$/, "") : decimal;
  if (!Number.isFinite(number) || String(number) !== normalized) throw new ContractError("VALUE_NOT_REPRESENTABLE");
  return number;
}

/** Segundos Unix inteiros a partir do ISO do evento. */
export const unixSeconds = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

/** YYYY-MM-DD HH:MM:SS em UTC (formato da UTMify). */
export const utcDateTime = (iso: string): string => new Date(iso).toISOString().slice(0, 19).replace("T", " ");

/** Monta a URL final do transporte com os parâmetros secretos, sem alterar o request auditado. */
export function withSecretQuery(request: HttpRequest): string {
  if (!request.secretQuery || Object.keys(request.secretQuery).length === 0) return request.url;
  const url = new URL(request.url);
  for (const [key, value] of Object.entries(request.secretQuery)) url.searchParams.set(key, value);
  return url.toString();
}
