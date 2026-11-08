import { describe, expect, it } from "vitest";
import { parseEnvelope, parseOrderPaid } from "../../src/modules/orders/payload.js";

// Exemplo exato do documento original (seção 4).
const documentExample = {
  eventId: "evt_123",
  event: "ORDER_PAID",
  orderId: "ORD-001",
  sessionId: "session_123",
  amount: 25500,
  currency: "USD",
  customer: { email: "cliente@email.com" },
  customFields: { source: "facebook", campaign: "black-friday", content: "criativo-01", affiliateCode: "AFF-001" },
};

describe("parseOrderPaid: campos obrigatórios", () => {
  it("interpreta o exemplo do documento", () => {
    const r = parseOrderPaid(documentExample);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      eventId: "evt_123", orderId: "ORD-001", amountMinor: 25500n, currency: "USD",
      sessionId: "session_123", customerEmail: "cliente@email.com", warnings: [],
    });
    expect(r.data.customFields).toEqual(documentExample.customFields);
  });

  it.each([
    ["sem eventId", { ...documentExample, eventId: undefined }],
    ["sem orderId", { ...documentExample, orderId: undefined }],
    ["sem amount", { ...documentExample, amount: undefined }],
    ["sem currency", { ...documentExample, currency: undefined }],
    ["amount decimal", { ...documentExample, amount: 255.5 }],
    ["amount negativo", { ...documentExample, amount: -1 }],
    ["amount como texto", { ...documentExample, amount: "25500" }],
    ["amount acima do inteiro seguro", { ...documentExample, amount: 2 ** 53 }],
    ["moeda inexistente", { ...documentExample, currency: "ZZZ" }],
    ["moeda com símbolo", { ...documentExample, currency: "US$" }],
    ["corpo não é objeto", "texto"],
    ["corpo nulo", null],
  ])("rejeita: %s", (_n, body) => {
    expect(parseOrderPaid(body).ok).toBe(false);
  });

  it("aceita amount zero e normaliza a moeda para maiúsculas", () => {
    const r = parseOrderPaid({ ...documentExample, amount: 0, currency: " usd " });
    expect(r.ok && r.data.amountMinor).toBe(0n);
    expect(r.ok && r.data.currency).toBe("USD");
  });

  it("não ecoa valores nos erros", () => {
    const r = parseOrderPaid({ ...documentExample, currency: "SEGREDO" });
    expect(JSON.stringify(r)).not.toContain("SEGREDO");
  });
});

describe("parseOrderPaid: campos opcionais malformados não derrubam a venda (ADR-033)", () => {
  it("ignora com aviso e sem valores", () => {
    const r = parseOrderPaid({
      ...documentExample,
      sessionId: "tem espaço",
      customer: { email: "ruim" },
      customFields: "texto",
      identifiers: { fbclid: 123, gclid: "ok-gclid" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.sessionId).toBeNull();
    expect(r.data.customerEmail).toBeNull();
    expect(r.data.customFields).toBeNull();
    expect(r.data.identifiers.fbclid).toBeNull();
    expect(r.data.identifiers.gclid).toBe("ok-gclid");
    expect(r.data.warnings).toEqual([
      "sessionId ignorado: formato inválido",
      "customer.email ignorado: formato inválido",
      "customFields ignorado: deve ser um objeto",
      "identifiers.fbclid ignorado: formato inválido",
    ]);
    expect(JSON.stringify(r.data.warnings)).not.toContain("tem espaço");
  });

  it("trata customFields vazio como ausente e preserva objeto com valores aninhados", () => {
    expect(parseOrderPaid({ ...documentExample, customFields: {} })).toMatchObject({ ok: true, data: { customFields: null } });
    const nested = { source: "facebook", extra: { a: 1 } };
    expect(parseOrderPaid({ ...documentExample, customFields: nested })).toMatchObject({ ok: true, data: { customFields: nested } });
  });

  it("normaliza e-mail e identificadores", () => {
    const r = parseOrderPaid({ ...documentExample, customer: { email: " Cliente@Email.COM " }, identifiers: { fbclid: "  AbC  ", ttp: "  " } });
    expect(r.ok && r.data.customerEmail).toBe("cliente@email.com");
    expect(r.ok && r.data.identifiers.fbclid).toBe("AbC");
    expect(r.ok && r.data.identifiers.ttp).toBeNull();
  });

  it("aceita pedido sem sessão, sem cliente e sem campos (venda não atribuível)", () => {
    const r = parseOrderPaid({ eventId: "e", event: "ORDER_PAID", orderId: "o", amount: 1, currency: "USD" });
    expect(r).toMatchObject({ ok: true, data: { sessionId: null, customerEmail: null, customFields: null, warnings: [] } });
  });
});

describe("parseEnvelope", () => {
  it("exige eventId, event e orderId para qualquer tipo de evento", () => {
    expect(parseEnvelope({ eventId: "e", event: "ORDER_REFUNDED", orderId: "o" }).ok).toBe(true);
    expect(parseEnvelope({ event: "ORDER_REFUNDED", orderId: "o" }).ok).toBe(false);
  });
});
