import { describe, expect, it } from "vitest";
import { createTikTokProvider } from "../../src/modules/conversions/providers/tiktok.js";
import { createTikTokSimulator } from "../../src/modules/conversions/simulators/tiktok.js";
import { ContractError, TransportError, type HttpRequest } from "../../src/modules/conversions/types.js";
import { sha256Hex } from "../../src/shared/pii.js";
import { NOW, onlyIdentifiers, sampleEvent } from "./helpers/events.js";

const config = { pixelCode: "SIMPIXELCODE", accessToken: "SEGREDO-TIKTOK-TOKEN" };
const setup = () => {
  const sim = createTikTokSimulator();
  return { sim, provider: createTikTokProvider(config, sim.transport) };
};
type Body = { event_source: string; event_source_id: string; data: Record<string, unknown>[] };
const bodyOf = (request: HttpRequest) => request.body as Body;
const eventOf = (request: HttpRequest) => bodyOf(request).data[0]!;
const userOf = (request: HttpRequest) => eventOf(request)["user"] as Record<string, unknown>;

describe("TikTok: contrato do payload", () => {
  const { provider } = setup();

  it("monta o request conforme o contrato adotado (ADR-037)", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://business-api.tiktok.com/open_api/v1.3/event/track/");
    expect(bodyOf(request)).toMatchObject({ event_source: "web", event_source_id: "SIMPIXELCODE" });
    expect(eventOf(request)).toMatchObject({
      event: "Purchase",
      event_time: 1768046400,
      event_id: "ORD-001",
      properties: { currency: "USD", value: 255 },
    });
  });

  it("a credencial vai só no cabeçalho Access-Token", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.headers["Access-Token"]).toBe("SEGREDO-TIKTOK-TOKEN");
    expect(request.url).not.toContain("SEGREDO");
    expect(JSON.stringify(request.body)).not.toContain("SEGREDO");
  });

  it("ttclid e ttp seguem sem hash, exatamente como capturados", () => {
    const user = userOf(provider.buildRequest(sampleEvent()));
    expect(user["ttclid"]).toBe("tiktok-click-id");
    expect(user["ttp"]).toBe("tiktok-cookie");
  });

  it("e-mail: trim, minúsculas, SHA-256. Telefone: E.164 com + em SHA-256", () => {
    const user = userOf(provider.buildRequest(sampleEvent()));
    expect(user["email"]).toBe(sha256Hex("cliente@email.com"));
    expect(user["phone"]).toBe(sha256Hex("+5511999999999"));
  });

  it("normaliza o e-mail antes do hash", () => {
    const event = sampleEvent();
    const user = userOf(provider.buildRequest({ ...event, customer: { ...event.customer, email: "  Cliente@Email.COM " } }));
    expect(user["email"]).toBe(sha256Hex("cliente@email.com"));
  });

  it("NÃO aplica a regra do Gmail do Google", () => {
    const event = sampleEvent();
    const user = userOf(provider.buildRequest({ ...event, customer: { ...event.customer, email: "Jane.Doe+Shop@Gmail.com" } }));
    expect(user["email"]).toBe(sha256Hex("jane.doe+shop@gmail.com"));
  });

  it("o telefone da Meta (sem +) é diferente do usado aqui (com +)", () => {
    const user = userOf(provider.buildRequest(sampleEvent()));
    expect(user["phone"]).not.toBe(sha256Hex("5511999999999"));
  });

  it("sem e-mail ou telefone, não os envia nem hasheia texto vazio", () => {
    const request = provider.buildRequest(sampleEvent({ customer: { email: null, phone: null } }));
    expect(Object.keys(userOf(request)).sort()).toEqual(["ttclid", "ttp"]);
    expect(JSON.stringify(request.body)).not.toContain(sha256Hex(""));
  });

  it("não envia afiliado, e-mail nem telefone em claro", () => {
    const serialized = JSON.stringify(provider.buildRequest(sampleEvent()).body);
    expect(serialized).not.toContain("AFF-001");
    expect(serialized).not.toContain("cliente@email.com");
    expect(serialized).not.toContain("5511999999999");
  });

  it("valores sem representação exata em número JSON são recusados", () => {
    expect(() => provider.buildRequest(sampleEvent({ amountDecimal: "90071992547409.93" }))).toThrow(ContractError);
  });
});

describe("TikTok: elegibilidade (ADR-016, ADR-037)", () => {
  const { provider } = setup();

  it("elegível com ttclid e ttp, só ttclid ou só ttp", () => {
    expect(provider.eligibility(sampleEvent(), NOW)).toEqual({ eligible: true });
    expect(provider.eligibility(onlyIdentifiers(sampleEvent(), "ttclid"), NOW)).toEqual({ eligible: true });
    expect(provider.eligibility(onlyIdentifiers(sampleEvent(), "ttp"), NOW)).toEqual({ eligible: true });
  });
  it("SKIPPED sem ttclid nem ttp, mesmo com e-mail e telefone", () => {
    expect(provider.eligibility(onlyIdentifiers(sampleEvent(), "fbc", "gclid"), NOW)).toEqual({
      eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:ttclid|ttp",
    });
  });
});

describe("TikTok: envio contra o simulador do contrato", () => {
  it("aceita o payload gerado e audita sem a credencial", async () => {
    const { sim, provider } = setup();
    const result = await provider.send(sampleEvent());
    expect(result).toMatchObject({ outcome: "SUCCESS", httpStatus: 200, error: null });
    expect(result.responseBody).toMatchObject({ code: 0 });
    expect(JSON.stringify(result.request)).not.toContain("SEGREDO");
    expect(result.request.body).toEqual(sim.accepted[0]!.body);
  });

  it("o simulador recusa violações do contrato (prova que o contrato é validado)", async () => {
    const { sim, provider } = setup();
    const status = async (mutate: (r: HttpRequest) => void) => {
      const request = provider.buildRequest(sampleEvent());
      mutate(request);
      return (await sim.transport.request(request)).status;
    };
    expect(await status((r) => { userOf(r)["email"] = "cliente@email.com"; })).toBe(400);
    expect(await status((r) => { userOf(r)["phone"] = "+5511999999999"; })).toBe(400);
    expect(await status((r) => { userOf(r)["ttclid"] = sha256Hex("x"); })).toBe(400);
    expect(await status((r) => { delete eventOf(r)["event_id"]; })).toBe(400);
    expect(await status((r) => { eventOf(r)["event_time"] = "2026-01-10T12:00:00Z"; })).toBe(400);
    expect(await status((r) => { eventOf(r)["user"] = {}; })).toBe(400);
    expect(await status((r) => { eventOf(r)["properties"] = { value: 1 }; })).toBe(400);
    expect(await status((r) => { bodyOf(r).event_source = "app"; })).toBe(400);
    expect(await status((r) => { r.headers = {}; })).toBe(401);
  });
});

describe("TikTok: classificação de resultados", () => {
  it("HTTP 200 com code diferente de 0 é permanente (suposição documentada)", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 200, body: { code: 40002, message: "invalid" } });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "PERMANENT", httpStatus: 200, error: "TikTok code 40002" });
  });
  it("HTTP 200 com code 40100 (limite de requisições, oficial) é transitório e espera 5 minutos", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 200, body: { code: 40100, message: "Too many requests" } });
    expect(await provider.send(sampleEvent())).toMatchObject({
      outcome: "TRANSIENT", httpStatus: 200, retryAfterMs: 300_000, error: "TikTok code 40100 (limite de requisições)",
    });
  });

  it("HTTP 200 sem campo code continua sendo sucesso", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 200, body: { ok: true } });
    expect((await provider.send(sampleEvent())).outcome).toBe("SUCCESS");
  });
  it("503 e 429 são transitórios", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 503 });
    expect((await provider.send(sampleEvent())).outcome).toBe("TRANSIENT");
    sim.failNext(1, { status: 429, headers: { "Retry-After": "5" } });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", retryAfterMs: 5000 });
  });
  it("400, 401 e 403 são permanentes", async () => {
    const { sim, provider } = setup();
    for (const status of [400, 401, 403]) {
      sim.failNext(1, { status });
      expect((await provider.send(sampleEvent())).outcome).toBe("PERMANENT");
    }
  });
  it("falha de rede é transitória e não lança", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { throws: new TransportError("timeout", "sem resposta") });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", httpStatus: null });
  });
});
