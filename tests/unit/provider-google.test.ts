import { describe, expect, it } from "vitest";
import { createGoogleProvider } from "../../src/modules/conversions/providers/google.js";
import { createGoogleSimulator } from "../../src/modules/conversions/simulators/google.js";
import { ContractError, TransportError, type HttpRequest } from "../../src/modules/conversions/types.js";
import { sha256Hex } from "../../src/shared/pii.js";
import { NOW, onlyIdentifiers, sampleEvent, withoutIdentifiers } from "./helpers/events.js";

const config = { accountId: "1234567890", conversionActionId: "9876543210", accessToken: "SEGREDO-GOOGLE-TOKEN" };
const setup = () => {
  const sim = createGoogleSimulator();
  return { sim, provider: createGoogleProvider(config, sim.transport) };
};
type Body = { destinations: unknown[]; encoding?: string; events: Record<string, unknown>[] };
const bodyOf = (request: HttpRequest) => request.body as Body;
const eventOf = (request: HttpRequest) => bodyOf(request).events[0]!;
const identifiersOf = (request: HttpRequest) =>
  ((eventOf(request)["userData"] as { userIdentifiers: Record<string, string>[] } | undefined)?.userIdentifiers ?? []);

describe("Google: contrato do payload (Data Manager API)", () => {
  const { provider } = setup();

  it("monta o request conforme o contrato confirmado (ADR-037)", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://datamanager.googleapis.com/v1/events:ingest");
    expect(bodyOf(request).destinations).toEqual([
      { operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" }, productDestinationId: "9876543210" },
    ]);
    expect(eventOf(request)).toMatchObject({
      eventTimestamp: "2026-01-10T12:00:00.000Z",
      transactionId: "ORD-001",
      eventSource: "WEB",
      conversionValue: 255,
      currency: "USD",
      adIdentifiers: { gclid: "google-click-id" },
    });
  });

  it("a credencial vai só no cabeçalho, nunca no corpo nem na URL", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.headers["Authorization"]).toBe("Bearer SEGREDO-GOOGLE-TOKEN");
    expect(request.url).not.toContain("SEGREDO");
    expect(JSON.stringify(request.body)).not.toContain("SEGREDO");
  });

  it("envia todos os identificadores de clique capturados (gclid, gbraid, wbraid)", () => {
    const event = sampleEvent();
    const all = { ...event, identifiers: { ...event.identifiers, gbraid: { value: "gb-1", source: "SESSION" as const }, wbraid: { value: "wb-1", source: "SESSION" as const } } };
    expect(eventOf(provider.buildRequest(all))["adIdentifiers"]).toEqual({ gclid: "google-click-id", gbraid: "gb-1", wbraid: "wb-1" });
  });

  it("e-mail: regra do Google. Remove pontos e +sufixo de gmail.com e googlemail.com", () => {
    const event = sampleEvent();
    const request = provider.buildRequest({ ...event, customer: { ...event.customer, email: " Jane.Doe+Shopping@GoogleMail.com " } });
    expect(identifiersOf(request)[0]).toEqual({ emailAddress: sha256Hex("janedoe@googlemail.com") });
  });

  it("e-mail de outro domínio mantém pontos e + (só minúsculas e trim)", () => {
    const event = sampleEvent();
    const request = provider.buildRequest({ ...event, customer: { ...event.customer, email: "User.Name+NYC@Example.com" } });
    expect(identifiersOf(request)[0]).toEqual({ emailAddress: sha256Hex("user.name+nyc@example.com") });
  });

  it("telefone: E.164 com o +, em SHA-256", () => {
    expect(identifiersOf(provider.buildRequest(sampleEvent()))[1]).toEqual({ phoneNumber: sha256Hex("+5511999999999") });
  });

  it("cada UserIdentifier carrega UM só campo (oficial)", () => {
    for (const identifier of identifiersOf(provider.buildRequest(sampleEvent()))) {
      expect(Object.keys(identifier)).toHaveLength(1);
    }
  });

  it("com dados do usuário, declara encoding HEX. Sem eles, omite encoding e userData", () => {
    const withUser = provider.buildRequest(sampleEvent());
    expect(bodyOf(withUser).encoding).toBe("HEX");
    const without = provider.buildRequest(sampleEvent({ customer: { email: null, phone: null } }));
    expect(bodyOf(without).encoding).toBeUndefined();
    expect(eventOf(without)).not.toHaveProperty("userData");
  });

  it("telefone fora do E.164 é omitido, e não hasheado", () => {
    const event = sampleEvent();
    const request = provider.buildRequest({ ...event, customer: { email: null, phone: "11999999999" } });
    expect(eventOf(request)).not.toHaveProperty("userData");
  });

  it("não envia consentimento nem afiliado (não temos o dado e o contrato não tem o campo)", () => {
    const request = provider.buildRequest(sampleEvent());
    const serialized = JSON.stringify(request.body);
    expect(serialized).not.toContain("consent");
    expect(serialized).not.toContain("AFF-001");
  });

  it("não envia e-mail nem telefone em claro", () => {
    const serialized = JSON.stringify(provider.buildRequest(sampleEvent()).body);
    expect(serialized).not.toContain("cliente@email.com");
    expect(serialized).not.toContain("5511999999999");
  });

  it("valores sem representação exata em número JSON são recusados", () => {
    expect(() => provider.buildRequest(sampleEvent({ amountDecimal: "90071992547409.93" }))).toThrow(ContractError);
  });
});

describe("Google: elegibilidade (ADR-016, ADR-037)", () => {
  const { provider } = setup();

  it("elegível com gclid, gbraid ou wbraid", () => {
    for (const field of ["gclid", "gbraid", "wbraid"]) {
      const event = onlyIdentifiers(sampleEvent(), "fbc");
      const withField = { ...event, identifiers: { [field]: { value: "x", source: "SESSION" as const } } };
      expect(provider.eligibility(withField, NOW)).toEqual({ eligible: true });
    }
  });
  it("SKIPPED sem identificador de clique, mesmo com e-mail e telefone", () => {
    expect(provider.eligibility(onlyIdentifiers(sampleEvent(), "fbc", "fbp", "ttclid"), NOW)).toEqual({
      eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:gclid|gbraid|wbraid",
    });
  });
  it("não aplica limite de idade (a documentação não define um)", () => {
    const old = sampleEvent({ occurredAt: "2020-01-01T00:00:00.000Z" });
    expect(provider.eligibility(old, NOW)).toEqual({ eligible: true });
  });
  it("não há exigência de pageUrl", () => {
    expect(provider.eligibility(sampleEvent({ pageUrl: null }), NOW)).toEqual({ eligible: true });
  });
});

describe("Google: envio contra o simulador do contrato", () => {
  it("aceita o payload gerado e audita sem a credencial", async () => {
    const { sim, provider } = setup();
    const result = await provider.send(sampleEvent());
    expect(result).toMatchObject({ outcome: "SUCCESS", httpStatus: 200, error: null });
    expect(result.responseBody).toEqual({ requestId: "SIMULATED" });
    expect(sim.accepted).toHaveLength(1);
    expect(JSON.stringify(result.request)).not.toContain("SEGREDO");
    expect(result.request.body).toEqual(sim.accepted[0]!.body);
  });

  it("aceita evento só com gbraid e sem dados do usuário", async () => {
    const { provider } = setup();
    const event = { ...sampleEvent({ customer: { email: null, phone: null } }), identifiers: { gbraid: { value: "gb", source: "SESSION" as const } } };
    expect((await provider.send(event)).outcome).toBe("SUCCESS");
  });

  it("o simulador recusa violações do contrato (prova que o contrato é validado)", async () => {
    const { sim, provider } = setup();
    const send = (mutate: (body: Body) => void) => {
      const request = provider.buildRequest(sampleEvent());
      mutate(bodyOf(request));
      return sim.transport.request(request);
    };
    const status = async (mutate: (body: Body) => void) => (await send(mutate)).status;
    expect(await status((b) => { delete b.events[0]!["transactionId"]; })).toBe(400);
    expect(await status((b) => { delete b.events[0]!["eventTimestamp"]; })).toBe(400);
    expect(await status((b) => { b.events[0]!["eventTimestamp"] = "2026-01-10 12:00:00"; })).toBe(400);
    expect(await status((b) => { b.events[0]!["eventSource"] = "OFFLINE"; })).toBe(400);
    expect(await status((b) => { delete b.events[0]!["currency"]; })).toBe(400);
    expect(await status((b) => { delete b.encoding; })).toBe(400);
    expect(await status((b) => { b.events[0]!["adIdentifiers"] = {}; b.events[0]!["userData"] = undefined; })).toBe(400);
    expect(await status((b) => { (b.events[0]!["userData"] as { userIdentifiers: unknown[] }).userIdentifiers = [{ emailAddress: "cliente@email.com" }]; })).toBe(400);
    expect(await status((b) => { (b.events[0]!["userData"] as { userIdentifiers: unknown[] }).userIdentifiers = [{ emailAddress: sha256Hex("a"), phoneNumber: sha256Hex("b") }]; })).toBe(400);
    expect(await status((b) => { b.destinations = []; })).toBe(400);
  });

  it("o simulador exige a credencial", async () => {
    const { sim, provider } = setup();
    const request = provider.buildRequest(sampleEvent());
    request.headers = {};
    expect((await sim.transport.request(request)).status).toBe(401);
  });
});

describe("Google: classificação de resultados", () => {
  it("503 e 429 (com Retry-After) são transitórios", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 503 });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", httpStatus: 503 });
    sim.failNext(1, { status: 429, headers: { "retry-after": "10" } });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", retryAfterMs: 10_000 });
  });
  it("400, 401 e 403 são permanentes (credencial ou dado errado não melhora sozinho)", async () => {
    const { sim, provider } = setup();
    for (const status of [400, 401, 403]) {
      sim.failNext(1, { status });
      expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "PERMANENT", httpStatus: status });
    }
  });
  it("falha de rede é transitória e não lança", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { throws: new TransportError("network", "ECONNRESET") });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", httpStatus: null });
  });
});

describe("Google: reuso de helpers de teste", () => {
  it("withoutIdentifiers remove só o que foi pedido", () => {
    const stripped = withoutIdentifiers(sampleEvent(), "gclid");
    expect(stripped.identifiers.gclid).toBeUndefined();
    expect(stripped.identifiers.fbc).toBeDefined();
  });
});
