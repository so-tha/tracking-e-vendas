import { describe, expect, it } from "vitest";
import { buildConversionEvent, parseConversionEvent, type EventInput } from "../../src/modules/conversions/event.js";

const base = (): EventInput => ({
  order: { orderId: "ORD-001", amountMinor: 25500n, currency: "USD", customerEmail: "cliente@email.com", receivedAt: new Date("2026-01-10T12:00:00.000Z") },
  attribution: {
    result: "ATTRIBUTED", level: 1, sessionId: "session_123",
    identifiers: { fbc: { value: "fb.1.1700000000.AbC", source: "SESSION" } },
    customFields: { source: "facebook", affiliateCode: "AFF-001" },
    affiliate: { code: "AFF-001", source: "WEBHOOK", evidenceLevel: 1 },
    alerts: [],
  },
  session: { pageUrl: "https://checkout.exemplo.com/produto", customerEmail: "sessao@email.com", customerPhone: "+5511999999999" },
});

describe("buildConversionEvent", () => {
  it("monta o evento com valor decimal sem ponto flutuante e instante em ISO", () => {
    const e = buildConversionEvent(base());
    expect(e).toMatchObject({
      version: 1, eventId: "ORD-001", orderId: "ORD-001", eventName: "Purchase",
      occurredAt: "2026-01-10T12:00:00.000Z", amountMinor: "25500", currency: "USD", amountDecimal: "255.00",
      pageUrl: "https://checkout.exemplo.com/produto", attributionLevel: 1, sessionId: "session_123",
    });
  });

  it("respeita as casas decimais da moeda", () => {
    const jpy = buildConversionEvent({ ...base(), order: { ...base().order, amountMinor: 500n, currency: "JPY" } });
    expect(jpy.amountDecimal).toBe("500");
    const kwd = buildConversionEvent({ ...base(), order: { ...base().order, amountMinor: 1234n, currency: "KWD" } });
    expect(kwd.amountDecimal).toBe("1.234");
  });

  it("é serializável em JSON e volta idêntico (vai para Conversion.eventSnapshot)", () => {
    const e = buildConversionEvent(base());
    expect(parseConversionEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("rejeita snapshot de versão desconhecida", () => {
    expect(() => parseConversionEvent({ version: 2 })).toThrow();
    expect(() => parseConversionEvent(null)).toThrow();
  });
});

describe("afiliado restrito aos níveis 1 a 3 (ADR-018)", () => {
  it.each([1, 2, 3] as const)("nível %i: o afiliado vai no evento", (level) => {
    const input = base();
    input.attribution.affiliate = { code: "AFF-001", source: "SESSION", evidenceLevel: level };
    expect(buildConversionEvent(input).affiliateCode).toBe("AFF-001");
  });

  it("nível 4: o afiliado NÃO vai no evento", () => {
    const input = base();
    input.attribution.level = 4;
    input.attribution.affiliate = { code: "AFF-001", source: "SESSION", evidenceLevel: 4 };
    expect(buildConversionEvent(input).affiliateCode).toBeNull();
  });

  it("venda não atribuída (evidência nula): o afiliado NÃO vai no evento", () => {
    const input = base();
    input.attribution = { ...input.attribution, result: "UNATTRIBUTED", level: null, sessionId: null, affiliate: { code: "AFF-9", source: "WEBHOOK", evidenceLevel: null } };
    input.session = null;
    expect(buildConversionEvent(input).affiliateCode).toBeNull();
  });

  it("sem afiliado: nulo", () => {
    const input = base();
    input.attribution.affiliate = null;
    expect(buildConversionEvent(input).affiliateCode).toBeNull();
  });
});

describe("dados pessoais do cliente (ADR-036)", () => {
  it("usa o e-mail do webhook e o telefone da sessão confiável", () => {
    const e = buildConversionEvent(base());
    expect(e.customer).toEqual({ email: "cliente@email.com", phone: "+5511999999999" });
  });

  it("completa o e-mail com o da sessão quando o webhook não trouxe", () => {
    const input = base();
    input.order.customerEmail = null;
    expect(buildConversionEvent(input).customer.email).toBe("sessao@email.com");
  });

  it("com ATTRIBUTION_CONFLICT, não usa nenhum dado pessoal da sessão", () => {
    const input = base();
    input.order.customerEmail = null;
    input.attribution.alerts = [{ code: "ATTRIBUTION_CONFLICT", details: [{ kind: "EMAIL_MISMATCH" }] }];
    expect(buildConversionEvent(input).customer).toEqual({ email: null, phone: null });
  });

  it("alerta que não é conflito de atribuição não bloqueia o uso da sessão", () => {
    const input = base();
    input.attribution.alerts = [{ code: "CUSTOM_FIELDS_DIVERGENCE", details: { used: "WEBHOOK" } }];
    expect(buildConversionEvent(input).customer.phone).toBe("+5511999999999");
  });

  it("venda não atribuída: só o e-mail do webhook, sem telefone e sem pageUrl", () => {
    const input = base();
    input.attribution = { ...input.attribution, result: "UNATTRIBUTED", level: null, sessionId: null, affiliate: null };
    input.session = null;
    const e = buildConversionEvent(input);
    expect(e.customer).toEqual({ email: "cliente@email.com", phone: null });
    expect(e.pageUrl).toBeNull();
  });
});
