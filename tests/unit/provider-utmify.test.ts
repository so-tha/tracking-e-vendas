import { describe, expect, it } from "vitest";
import { createUtmifyProvider } from "../../src/modules/conversions/providers/utmify.js";
import { createUtmifySimulator } from "../../src/modules/conversions/simulators/utmify.js";
import { ContractError, TransportError, type HttpRequest } from "../../src/modules/conversions/types.js";
import { NOW, onlyIdentifiers, sampleEvent } from "./helpers/events.js";

const config = { apiToken: "SEGREDO-UTMIFY-TOKEN", platform: "TrackingHub", paymentMethod: "credit_card" as const, customerName: "Cliente" };
const setup = () => {
  const sim = createUtmifySimulator({ now: () => NOW });
  return { sim, provider: createUtmifyProvider(config, sim.transport) };
};
type Body = Record<string, any>;
const bodyOf = (request: HttpRequest) => request.body as Body;

describe("UTMify: contrato do payload (oficial)", () => {
  const { provider } = setup();

  it("monta o payload com todas as chaves obrigatórias do contrato", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.utmify.com.br/api-credentials/orders");
    expect(bodyOf(request)).toEqual({
      orderId: "ORD-001",
      platform: "TrackingHub",
      paymentMethod: "credit_card",
      status: "paid",
      createdAt: "2026-01-10 12:00:00",
      approvedDate: "2026-01-10 12:00:00",
      refundedAt: null,
      customer: { name: "Cliente", email: "cliente@email.com", phone: "5511999999999", document: null },
      products: [{ id: "ORD-001", name: "Pedido ORD-001", planId: null, planName: null, quantity: 1, priceInCents: 25500 }],
      trackingParameters: {
        src: null,
        sck: "utmify-id",
        utm_source: "facebook",
        utm_campaign: "black-friday",
        utm_content: "criativo-01",
        utm_medium: null,
        utm_term: null,
      },
      commission: { totalPriceInCents: 25500, gatewayFeeInCents: 0, userCommissionInCents: 25500, currency: "USD" },
    });
  });

  it("o token vai só no cabeçalho x-api-token", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.headers["x-api-token"]).toBe("SEGREDO-UTMIFY-TOKEN");
    expect(JSON.stringify(request.body)).not.toContain("SEGREDO");
    expect(request.url).not.toContain("SEGREDO");
    expect(request.secretQuery).toBeUndefined();
  });

  it("datas em UTC no formato YYYY-MM-DD HH:MM:SS", () => {
    const body = bodyOf(provider.buildRequest(sampleEvent({ occurredAt: "2026-03-05T01:02:03.999Z" })));
    expect(body["createdAt"]).toBe("2026-03-05 01:02:03");
    expect(body["approvedDate"]).toBe("2026-03-05 01:02:03");
  });

  it("e-mail em texto claro (o contrato exige), normalizado em minúsculas", () => {
    const event = sampleEvent();
    const body = bodyOf(provider.buildRequest({ ...event, customer: { ...event.customer, email: "  Cliente@Email.COM " } }));
    expect(body["customer"]["email"]).toBe("cliente@email.com");
  });

  it("telefone em dígitos com código do país, ou nulo quando não há (a chave é obrigatória)", () => {
    const event = sampleEvent();
    expect(bodyOf(provider.buildRequest(event))["customer"]["phone"]).toBe("5511999999999");
    const withoutPhone = bodyOf(provider.buildRequest({ ...event, customer: { ...event.customer, phone: null } }));
    expect(withoutPhone["customer"]).toHaveProperty("phone", null);
    expect(withoutPhone["customer"]).toHaveProperty("document", null);
  });

  it("moeda: omitida para BRL e informada para as demais (oficial)", () => {
    const brl = bodyOf(provider.buildRequest(sampleEvent({ currency: "BRL" })));
    expect(brl["commission"]).not.toHaveProperty("currency");
    const usd = bodyOf(provider.buildRequest(sampleEvent({ currency: "USD" })));
    expect(usd["commission"]["currency"]).toBe("USD");
  });

  it("trackingParameters: as 7 chaves sempre presentes, nulas quando ausentes", () => {
    const body = bodyOf(provider.buildRequest(sampleEvent({ customFields: null })));
    expect(Object.keys(body["trackingParameters"]).sort()).toEqual(["sck", "src", "utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term"]);
    expect(body["trackingParameters"]["utm_source"]).toBeNull();
    expect(body["trackingParameters"]["sck"]).toBe("utmify-id");
  });

  it("customFields alimentam os utm. medium e term, quando existirem. Valores que não são texto viram nulo", () => {
    const body = bodyOf(provider.buildRequest(sampleEvent({ customFields: { source: "google", medium: "cpc", term: "tenis", campaign: 123, content: "  " } })));
    expect(body["trackingParameters"]).toMatchObject({ utm_source: "google", utm_medium: "cpc", utm_term: "tenis", utm_campaign: null, utm_content: null });
  });

  it("NÃO envia o afiliado: o contrato não tem campo para ele", () => {
    const serialized = JSON.stringify(provider.buildRequest(sampleEvent()).body);
    expect(serialized).not.toContain("AFF-001");
    expect(serialized).not.toContain("affiliate");
  });

  it("valor muito grande para inteiro seguro é recusado", () => {
    expect(() => provider.buildRequest(sampleEvent({ amountMinor: "9007199254740993" }))).toThrow(ContractError);
  });

  it("sem e-mail, o payload não pode ser montado", () => {
    expect(() => provider.buildRequest(sampleEvent({ customer: { email: null, phone: null } }))).toThrow(ContractError);
  });
});

describe("UTMify: elegibilidade (ADR-016, ADR-037)", () => {
  const { provider } = setup();

  it("elegível com e-mail e utmifyId", () => expect(provider.eligibility(sampleEvent(), NOW)).toEqual({ eligible: true }));
  it("elegível só com customFields de campanha (sem utmifyId)", () => {
    const event = { ...sampleEvent(), identifiers: {} };
    expect(provider.eligibility(event, NOW)).toEqual({ eligible: true });
  });
  it("elegível só com utmifyId (sem customFields)", () => {
    expect(provider.eligibility(onlyIdentifiers(sampleEvent({ customFields: null }), "utmifyId"), NOW)).toEqual({ eligible: true });
  });
  it("SKIPPED sem e-mail (campo obrigatório do contrato)", () => {
    expect(provider.eligibility(sampleEvent({ customer: { email: null, phone: null } }), NOW)).toEqual({
      eligible: false, reason: "MISSING_REQUIRED_FIELD:customer.email",
    });
  });
  it("SKIPPED sem utmifyId e sem dados de campanha", () => {
    const event = { ...sampleEvent({ customFields: { affiliateCode: "AFF-001" } }), identifiers: {} };
    expect(provider.eligibility(event, NOW)).toEqual({ eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:utmifyId|customFields" });
  });
  it("pedido com exatamente 7 dias é elegível, e um milissegundo a mais não", () => {
    const event = sampleEvent();
    const occurred = new Date(event.occurredAt).getTime();
    expect(provider.eligibility(event, new Date(occurred + 7 * 86_400_000)).eligible).toBe(true);
    expect(provider.eligibility(event, new Date(occurred + 7 * 86_400_000 + 1))).toEqual({ eligible: false, reason: "EVENT_TOO_OLD" });
  });
});

describe("UTMify: envio contra o simulador do contrato", () => {
  it("aceita o payload gerado e audita sem o token", async () => {
    const { sim, provider } = setup();
    const result = await provider.send(sampleEvent());
    expect(result).toMatchObject({ outcome: "SUCCESS", httpStatus: 200, error: null });
    expect(JSON.stringify(result.request)).not.toContain("SEGREDO");
    expect(result.request.body).toEqual(sim.accepted[0]!.body);
  });

  it("aceita pedido sem telefone, sem utms e só com sck (chaves nulas são válidas)", async () => {
    const { provider } = setup();
    const event = onlyIdentifiers(sampleEvent({ customFields: null, customer: { email: "a@a.com", phone: null } }), "utmifyId");
    expect((await provider.send(event)).outcome).toBe("SUCCESS");
  });

  it("o simulador recusa violações do contrato e informa os campos inválidos", async () => {
    const { sim, provider } = setup();
    const run = async (mutate: (body: Body) => void) => {
      const request = provider.buildRequest(sampleEvent());
      mutate(bodyOf(request));
      return sim.transport.request(request);
    };
    const invalid = async (mutate: (body: Body) => void) => (await run(mutate)).body as { invalidFields: string[] };

    expect((await invalid((b) => { b["paymentMethod"] = "cartao"; })).invalidFields).toContain("paymentMethod");
    expect((await invalid((b) => { b["status"] = "pago"; })).invalidFields).toContain("status");
    expect((await invalid((b) => { b["createdAt"] = "2026-01-10T12:00:00Z"; })).invalidFields).toContain("createdAt");
    expect((await invalid((b) => { delete b["refundedAt"]; })).invalidFields).toContain("refundedAt");
    expect((await invalid((b) => { delete b["customer"]["document"]; })).invalidFields).toContain("customer.document");
    expect((await invalid((b) => { b["customer"]["name"] = ""; })).invalidFields).toContain("customer.name");
    expect((await invalid((b) => { delete b["trackingParameters"]["sck"]; })).invalidFields).toContain("trackingParameters.sck");
    expect((await invalid((b) => { b["products"][0]["quantity"] = 0; })).invalidFields).toContain("products[0].quantity");
    expect((await invalid((b) => { b["products"][0]["priceInCents"] = 255.5; })).invalidFields).toContain("products[0].priceInCents");
    expect((await invalid((b) => { delete b["commission"]["gatewayFeeInCents"]; })).invalidFields).toContain("commission.gatewayFeeInCents");
    expect((await invalid((b) => { b["products"] = []; })).invalidFields).toContain("products");
  });

  it("o simulador recusa pedidos com mais de 7 dias (oficial)", async () => {
    const { sim, provider } = setup();
    const request = provider.buildRequest(sampleEvent({ occurredAt: "2026-01-02T12:00:00.000Z" }));
    const response = await sim.transport.request(request);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("older than 7 days");
  });

  it("o simulador exige o x-api-token (API_CREDENTIAL_NOT_FOUND)", async () => {
    const { sim, provider } = setup();
    const request = provider.buildRequest(sampleEvent());
    request.headers = {};
    expect(await sim.transport.request(request)).toMatchObject({ status: 401, body: { message: "API_CREDENTIAL_NOT_FOUND" } });
  });

  it("isTest valida sem salvar (oficial)", async () => {
    const { sim, provider } = setup();
    const request = provider.buildRequest(sampleEvent());
    bodyOf(request)["isTest"] = true;
    expect((await sim.transport.request(request)).body).toMatchObject({ saved: false });
  });
});

describe("UTMify: classificação de resultados", () => {
  it("503 e 429 são transitórios", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 503 });
    expect((await provider.send(sampleEvent())).outcome).toBe("TRANSIENT");
    sim.failNext(1, { status: 429, headers: { "Retry-After": "20" } });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", retryAfterMs: 20_000 });
  });
  it("400 (campos inválidos) e 401 (credencial) são permanentes", async () => {
    const { sim, provider } = setup();
    for (const status of [400, 401]) {
      sim.failNext(1, { status });
      expect((await provider.send(sampleEvent())).outcome).toBe("PERMANENT");
    }
  });
  it("falha de rede é transitória e não lança", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { throws: new TransportError("network", "ECONNRESET") });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", httpStatus: null });
  });
});
