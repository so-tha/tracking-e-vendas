import { describe, expect, it } from "vitest";
import { createMetaProvider } from "../../src/modules/conversions/providers/meta.js";
import { createMetaSimulator } from "../../src/modules/conversions/simulators/meta.js";
import { ContractError, TransportError, type HttpRequest } from "../../src/modules/conversions/types.js";
import { sha256Hex } from "../../src/shared/pii.js";
import { NOW, onlyIdentifiers, sampleEvent, withoutIdentifiers } from "./helpers/events.js";

const config = { pixelId: "SIM-PIXEL-1", accessToken: "SEGREDO-META-TOKEN", apiVersion: "v27.0" };
const setup = () => {
  const sim = createMetaSimulator({ now: () => NOW });
  return { sim, provider: createMetaProvider(config, sim.transport) };
};
const bodyOf = (request: HttpRequest) => (request.body as { data: Record<string, unknown>[] }).data[0]!;
const userData = (request: HttpRequest) => bodyOf(request)["user_data"] as Record<string, unknown>;

describe("Meta: contrato do payload", () => {
  const { provider } = setup();

  it("monta o request conforme o contrato confirmado (ADR-037)", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://graph.facebook.com/v27.0/SIM-PIXEL-1/events");
    expect(request.secretQuery).toEqual({ access_token: "SEGREDO-META-TOKEN" });

    const event = bodyOf(request);
    expect(event).toMatchObject({
      event_name: "Purchase",
      event_time: 1768046400, // 2026-01-10T12:00:00Z
      event_id: "ORD-001",
      event_source_url: "https://checkout.exemplo.com/produto",
      action_source: "website",
      custom_data: { currency: "USD", value: 255, affiliate_code: "AFF-001" },
    });
  });

  it("o token fica fora da URL e do que é auditado", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.url).not.toContain("SEGREDO");
    expect(JSON.stringify(request.body)).not.toContain("SEGREDO");
  });

  it("e-mail: trim, minúsculas e SHA-256; telefone: só dígitos com código do país, SHA-256", () => {
    const data = userData(provider.buildRequest(sampleEvent()));
    expect(data["em"]).toEqual([sha256Hex("cliente@email.com")]);
    expect(data["ph"]).toEqual([sha256Hex("5511999999999")]);
  });

  it("normaliza o e-mail antes do hash, mesmo que o evento traga maiúsculas e espaços", () => {
    const event = sampleEvent();
    const data = userData(provider.buildRequest({ ...event, customer: { ...event.customer, email: "  Cliente@Email.COM " } }));
    expect(data["em"]).toEqual([sha256Hex("cliente@email.com")]);
  });

  it("NÃO aplica a regra do Gmail (pontos e + permanecem), ao contrário do Google", () => {
    const event = sampleEvent();
    const data = userData(provider.buildRequest({ ...event, customer: { ...event.customer, email: "Jane.Doe+Shop@Gmail.com" } }));
    expect(data["em"]).toEqual([sha256Hex("jane.doe+shop@gmail.com")]);
  });

  it("fbc e fbp seguem sem hash, exatamente como capturados", () => {
    const data = userData(provider.buildRequest(sampleEvent()));
    expect(data["fbc"]).toBe("fb.1.1767268000000.AbCdEf");
    expect(data["fbp"]).toBe("fb.1.1767267000000.1234567890");
  });

  it("sem e-mail ou telefone, não envia em/ph nem o hash de texto vazio", () => {
    const event = sampleEvent();
    const request = provider.buildRequest({ ...event, customer: { email: null, phone: null } });
    expect(Object.keys(userData(request)).sort()).toEqual(["fbc", "fbp"]);
    expect(JSON.stringify(request.body)).not.toContain(sha256Hex(""));
  });

  it("telefone fora do formato E.164 é omitido, e não hasheado", () => {
    const event = sampleEvent();
    const data = userData(provider.buildRequest({ ...event, customer: { email: null, phone: "11999999999" } }));
    expect(data["ph"]).toBeUndefined();
  });

  it("o afiliado só aparece quando o evento o traz (já restrito aos níveis 1 a 3)", () => {
    const withAffiliate = bodyOf(provider.buildRequest(sampleEvent()))["custom_data"] as Record<string, unknown>;
    const without = bodyOf(provider.buildRequest(sampleEvent({ affiliateCode: null })))["custom_data"] as Record<string, unknown>;
    expect(withAffiliate["affiliate_code"]).toBe("AFF-001");
    expect(without).not.toHaveProperty("affiliate_code");
  });

  it("não envia e-mail nem telefone em claro em nenhum lugar do payload", () => {
    const serialized = JSON.stringify(provider.buildRequest(sampleEvent()).body);
    expect(serialized).not.toContain("cliente@email.com");
    expect(serialized).not.toContain("5511999999999");
  });

  it("valores sem representação exata em número JSON são recusados", () => {
    expect(() => provider.buildRequest(sampleEvent({ amountDecimal: "90071992547409.93" }))).toThrow(ContractError);
  });

  it("usa o valor decimal correto para moedas sem casas decimais", () => {
    const data = bodyOf(provider.buildRequest(sampleEvent({ currency: "JPY", amountDecimal: "500" })));
    expect(data["custom_data"]).toMatchObject({ currency: "JPY", value: 500 });
  });
});

describe("Meta: elegibilidade (ADR-016, ADR-037)", () => {
  const { provider } = setup();

  it("elegível com fbc e fbp", () => expect(provider.eligibility(sampleEvent(), NOW)).toEqual({ eligible: true }));
  it("elegível só com fbp", () => {
    expect(provider.eligibility(withoutIdentifiers(sampleEvent(), "fbc"), NOW)).toEqual({ eligible: true });
  });
  it("elegível só com fbc", () => {
    expect(provider.eligibility(withoutIdentifiers(sampleEvent(), "fbp"), NOW)).toEqual({ eligible: true });
  });
  it("SKIPPED sem fbc nem fbp, mesmo com e-mail e telefone (envio só por e-mail está fora do escopo)", () => {
    expect(provider.eligibility(onlyIdentifiers(sampleEvent(), "gclid"), NOW)).toEqual({
      eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:fbc|fbp",
    });
  });
  it("SKIPPED sem pageUrl, que é obrigatório para eventos web", () => {
    expect(provider.eligibility(sampleEvent({ pageUrl: null }), NOW)).toEqual({ eligible: false, reason: "MISSING_REQUIRED_FIELD:event_source_url" });
  });
  it("evento com exatamente 7 dias é elegível, e um milissegundo a mais não", () => {
    const event = sampleEvent();
    const occurred = new Date(event.occurredAt).getTime();
    expect(provider.eligibility(event, new Date(occurred + 7 * 86_400_000)).eligible).toBe(true);
    expect(provider.eligibility(event, new Date(occurred + 7 * 86_400_000 + 1))).toEqual({ eligible: false, reason: "EVENT_TOO_OLD" });
  });
});

describe("Meta: envio contra o simulador do contrato", () => {
  it("aceita o payload gerado, e o provedor enxerga o token só na URL completa", async () => {
    const { sim, provider } = setup();
    const result = await provider.send(sampleEvent());

    expect(result).toMatchObject({ outcome: "SUCCESS", httpStatus: 200, error: null, retryAfterMs: null });
    expect(result.responseBody).toMatchObject({ events_received: 1 });
    expect(sim.accepted).toHaveLength(1);
    expect(sim.accepted[0]!.fullUrl).toContain("access_token=SEGREDO-META-TOKEN");
    // Auditoria: sem cabeçalhos e sem token.
    expect(JSON.stringify(result.request)).not.toContain("SEGREDO");
    expect(result.request.url).toBe("https://graph.facebook.com/v27.0/SIM-PIXEL-1/events");
  });

  it("o request auditado é exatamente o corpo enviado", async () => {
    const { sim, provider } = setup();
    const result = await provider.send(sampleEvent());
    expect(result.request.body).toEqual(sim.accepted[0]!.body);
  });

  it("enviar o mesmo evento duas vezes gera o mesmo corpo (determinístico para reprocessamento)", async () => {
    const { sim, provider } = setup();
    await provider.send(sampleEvent());
    await provider.send(sampleEvent());
    expect(sim.accepted[1]!.body).toEqual(sim.accepted[0]!.body);
  });

  it("o simulador recusa e-mail sem hash (prova que o contrato é validado)", async () => {
    const { sim } = setup();
    const { provider } = setup();
    const request = provider.buildRequest(sampleEvent());
    (userData(request) as Record<string, unknown>)["em"] = ["cliente@email.com"];
    const response = await sim.transport.request(request);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("em must be SHA-256 hashed");
  });

  it("o simulador recusa fbc com hash, event_time com mais de 7 dias e website sem URL", async () => {
    const { sim, provider } = setup();
    const send = (mutate: (r: HttpRequest) => void) => {
      const request = provider.buildRequest(sampleEvent());
      mutate(request);
      return sim.transport.request(request);
    };
    expect((await send((r) => { userData(r)["fbc"] = sha256Hex("x"); })).status).toBe(400);
    expect((await send((r) => { bodyOf(r)["event_time"] = Math.floor(NOW.getTime() / 1000) - 8 * 86_400; })).status).toBe(400);
    expect((await send((r) => { delete bodyOf(r)["event_source_url"]; })).status).toBe(400);
    expect((await send((r) => { bodyOf(r)["action_source"] = "inventado"; })).status).toBe(400);
    expect((await send((r) => { bodyOf(r)["user_data"] = {}; })).status).toBe(400);
    expect((await send((r) => { delete (bodyOf(r)["custom_data"] as Record<string, unknown>)["currency"]; })).status).toBe(400);
    expect((await send((r) => { r.secretQuery = {}; })).status).toBe(400);
  });
});

describe("Meta: classificação de resultados", () => {
  it("503 é transitório e 429 respeita o Retry-After", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 503 });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", httpStatus: 503 });
    sim.failNext(1, { status: 429, headers: { "Retry-After": "45" } });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", httpStatus: 429, retryAfterMs: 45_000 });
  });

  it("400 e 401 são permanentes", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 400 });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "PERMANENT", httpStatus: 400 });
    sim.failNext(1, { status: 401 });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "PERMANENT", httpStatus: 401 });
  });

  it("timeout de rede é transitório e não lança", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { throws: new TransportError("timeout", "sem resposta") });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", httpStatus: null, error: "timeout: sem resposta" });
  });

  it("depois da falha injetada, volta ao comportamento normal", async () => {
    const { sim, provider } = setup();
    sim.failNext(2, { status: 500 });
    expect((await provider.send(sampleEvent())).outcome).toBe("TRANSIENT");
    expect((await provider.send(sampleEvent())).outcome).toBe("TRANSIENT");
    expect((await provider.send(sampleEvent())).outcome).toBe("SUCCESS");
    expect(sim.requests).toHaveLength(3);
    expect(sim.accepted).toHaveLength(1);
  });
});
