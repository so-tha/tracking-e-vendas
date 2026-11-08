import { withSecretQuery } from "../http.js";
import { TransportError, type HttpRequest, type HttpResponse, type HttpTransport } from "../types.js";

/** Falha injetada de forma controlada (testes e demonstrações). */
export type Fault =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { throws: TransportError };

/** O que o provedor "vê": o request completo, inclusive a URL com os parâmetros secretos. */
export type SeenRequest = HttpRequest & { fullUrl: string };

export interface Simulator {
  transport: HttpTransport;
  /** Todo request recebido, inclusive os que receberam uma falha injetada. */
  requests: SeenRequest[];
  /** Requests que o simulador aceitou (resposta 2xx do contrato). */
  accepted: SeenRequest[];
  /** As próximas `count` chamadas recebem a falha, em vez do comportamento normal. */
  failNext(count: number, fault: Fault): void;
  reset(): void;
}

export type Handler = (request: SeenRequest) => HttpResponse;

/**
 * Simulador de provedor: valida o contrato documentado e devolve respostas.
 * Não faz nenhum tráfego real.
 */
export function createSimulator(handle: Handler): Simulator {
  const requests: SeenRequest[] = [];
  const accepted: SeenRequest[] = [];
  const faults: Fault[] = [];

  const transport: HttpTransport = {
    async request(request) {
      const seen: SeenRequest = { ...request, fullUrl: withSecretQuery(request) };
      requests.push(seen);

      const fault = faults.shift();
      if (fault) {
        if ("throws" in fault) throw fault.throws;
        return { status: fault.status, headers: fault.headers ?? {}, body: fault.body ?? { error: "falha injetada" } };
      }

      const response = handle(seen);
      if (response.status >= 200 && response.status < 300) accepted.push(seen);
      return response;
    },
  };

  return {
    transport,
    requests,
    accepted,
    failNext(count, fault) {
      for (let i = 0; i < count; i++) faults.push(fault);
    },
    reset() {
      requests.length = 0;
      accepted.length = 0;
      faults.length = 0;
    },
  };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body,
});

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
