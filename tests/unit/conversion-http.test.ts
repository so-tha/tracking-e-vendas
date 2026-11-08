import { describe, expect, it } from "vitest";
import {
  classifyHttp,
  decimalToNumber,
  executeSend,
  toAudited,
  unixSeconds,
  utcDateTime,
  withSecretQuery,
} from "../../src/modules/conversions/http.js";
import { ContractError, TransportError, type HttpRequest, type HttpTransport } from "../../src/modules/conversions/types.js";

const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers, body: null });

describe("classifyHttp (ADR-036)", () => {
  it.each([200, 201, 202, 204])("%i é sucesso", (s) => expect(classifyHttp(res(s)).outcome).toBe("SUCCESS"));
  it.each([408, 425, 429, 500, 502, 503, 504, 599])("%i é transitório", (s) => expect(classifyHttp(res(s)).outcome).toBe("TRANSIENT"));
  it.each([400, 401, 403, 404, 409, 410, 422])("%i é permanente (inclusive 401 e 403)", (s) => expect(classifyHttp(res(s)).outcome).toBe("PERMANENT"));
  it("lê Retry-After em segundos, sem diferenciar maiúsculas, e limita a 1h", () => {
    expect(classifyHttp(res(429, { "Retry-After": "30" })).retryAfterMs).toBe(30_000);
    expect(classifyHttp(res(503, { "retry-after": "999999" })).retryAfterMs).toBe(3_600_000);
  });
  it("ignora Retry-After inválido ou em respostas não transitórias", () => {
    expect(classifyHttp(res(429, { "retry-after": "amanhã" })).retryAfterMs).toBeNull();
    expect(classifyHttp(res(400, { "retry-after": "30" })).retryAfterMs).toBeNull();
  });
});

describe("decimalToNumber", () => {
  it.each([["255.00", 255], ["0.30", 0.3], ["0.05", 0.05], ["1.234", 1.234], ["100", 100], ["0.00", 0], ["10.50", 10.5]])("%s", (text, number) => {
    expect(decimalToNumber(text)).toBe(number);
  });
  it("recusa valores que o número JSON não representa exatamente", () => {
    expect(() => decimalToNumber("90071992547409.93")).toThrow(ContractError);
    expect(() => decimalToNumber("9007199254740993.00")).toThrow(ContractError);
  });
});

describe("formatadores de data", () => {
  it("unixSeconds corta os milissegundos", () => {
    expect(unixSeconds("2026-01-01T12:00:00.999Z")).toBe(1767268800);
  });
  it("utcDateTime usa YYYY-MM-DD HH:MM:SS em UTC (UTMify)", () => {
    expect(utcDateTime("2026-01-01T12:00:00.999Z")).toBe("2026-01-01 12:00:00");
  });
});

describe("executeSend e auditoria", () => {
  const request: HttpRequest = {
    method: "POST",
    url: "https://api.exemplo.com/events",
    headers: { Authorization: "Bearer SEGREDO-NO-HEADER", "x-api-token": "SEGREDO-2" },
    secretQuery: { access_token: "SEGREDO-NA-QUERY" },
    body: { a: 1 },
  };

  it("o request auditado não contém cabeçalhos nem parâmetros secretos", () => {
    const audited = JSON.stringify(toAudited(request));
    expect(audited).not.toContain("SEGREDO");
    expect(toAudited(request)).toEqual({ method: "POST", url: "https://api.exemplo.com/events", body: { a: 1 } });
  });

  it("withSecretQuery monta a URL final só para o transporte", () => {
    expect(withSecretQuery(request)).toBe("https://api.exemplo.com/events?access_token=SEGREDO-NA-QUERY");
    expect(withSecretQuery({ ...request, secretQuery: undefined })).toBe(request.url);
  });

  it("devolve o resultado classificado com status e corpo", async () => {
    const transport: HttpTransport = { request: async () => ({ status: 200, headers: {}, body: { ok: true } }) };
    expect(await executeSend(request, transport)).toMatchObject({ outcome: "SUCCESS", httpStatus: 200, responseBody: { ok: true }, error: null });
  });

  it("falha de rede vira TRANSIENT sem lançar", async () => {
    const transport: HttpTransport = { request: async () => { throw new TransportError("timeout", "sem resposta em 10s"); } };
    expect(await executeSend(request, transport)).toMatchObject({
      outcome: "TRANSIENT", httpStatus: null, responseBody: null, error: "timeout: sem resposta em 10s",
    });
  });

  it("erros que não são de transporte (bugs) são relançados", async () => {
    const transport: HttpTransport = { request: async () => { throw new TypeError("bug"); } };
    await expect(executeSend(request, transport)).rejects.toThrow(TypeError);
  });

  it("o refinamento do adaptador pode mudar o resultado", async () => {
    const transport: HttpTransport = { request: async () => ({ status: 200, headers: {}, body: { code: 40001 } }) };
    const result = await executeSend(request, transport, () => ({ outcome: "PERMANENT", error: "code 40001", retryAfterMs: null }));
    expect(result.outcome).toBe("PERMANENT");
  });
});
