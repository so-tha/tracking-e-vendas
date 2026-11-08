import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  normalizeCustomFields,
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
} from "../../src/modules/tracking/normalize.js";
import { normalizeSessionRequest, sessionRequestSchema } from "../../src/modules/tracking/schemas.js";

describe("normalizeIdentifier", () => {
  it("remove espaços das pontas e preserva maiúsculas (click IDs diferenciam caixa)", () => {
    expect(normalizeIdentifier("  AbC-123  ")).toBe("AbC-123");
  });
  it.each([[""], ["   "], [null], [undefined]])("trata %j como ausente", (v) => {
    expect(normalizeIdentifier(v)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("coloca em minúsculas e remove espaços", () => {
    expect(normalizeEmail("  Cliente@Email.COM ")).toEqual({ value: "cliente@email.com", invalid: false });
  });
  it("marca formato inválido sem lançar erro", () => {
    expect(normalizeEmail("isto-nao-e-email")).toEqual({ value: null, invalid: true });
  });
  it("vazio é ausente, e não inválido", () => {
    expect(normalizeEmail("  ")).toEqual({ value: null, invalid: false });
  });
});

describe("normalizePhone", () => {
  it("aceita E.164 e remove formatação", () => {
    expect(normalizePhone("+55 (11) 99999-9999").value).toBe("+5511999999999");
  });
  it.each([["11999999999"], ["+0123456789"], ["+55"], ["+551199999999999999"], ["abc"]])(
    "rejeita %s sem adivinhar o país",
    (v) => {
      expect(normalizePhone(v)).toEqual({ value: null, invalid: true });
    },
  );
});

describe("normalizeCustomFields", () => {
  it("trata {} e null como ausentes (ADR-022)", () => {
    expect(normalizeCustomFields({})).toBeNull();
    expect(normalizeCustomFields(null)).toBeNull();
    expect(normalizeCustomFields(undefined)).toBeNull();
  });
  it("preserva o objeto como veio", () => {
    expect(normalizeCustomFields({ source: "facebook", n: 1 })).toEqual({ source: "facebook", n: 1 });
  });
});

describe("canonicalJson", () => {
  it("não depende da ordem das chaves, inclusive em objetos aninhados", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it("distingue valores diferentes", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
});

describe("sessionRequestSchema", () => {
  const base = { sessionId: "session_123", pageUrl: "https://checkout.exemplo.com/produto" };

  it("aceita o exemplo do documento original", () => {
    const parsed = sessionRequestSchema.safeParse({
      ...base,
      customFields: { source: "facebook", campaign: "black-friday", content: "criativo-01", affiliateCode: "AFF-001" },
      identifiers: {
        fbclid: "fb-click-id", fbc: "meta-fbc", fbp: "meta-fbp", gclid: "google-click-id",
        gbraid: null, wbraid: null, ttclid: "tiktok-click-id", ttp: "tiktok-cookie",
        redtrackClickId: "redtrack-click-id", utmifyId: "utmify-id",
      },
      customer: { email: "cliente@email.com", phone: "+5511999999999" },
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["sem sessionId", { pageUrl: base.pageUrl }],
    ["sessionId com espaço", { ...base, sessionId: "a b" }],
    ["pageUrl com esquema perigoso", { ...base, pageUrl: "javascript:alert(1)" }],
    ["pageUrl inválida", { ...base, pageUrl: "não é url" }],
    ["customFields não objeto", { ...base, customFields: "texto" }],
    ["customFields com valor aninhado", { ...base, customFields: { a: { b: 1 } } }],
    ["identificador numérico", { ...base, identifiers: { fbclid: 123 } }],
    ["identificador com caractere de controle", { ...base, identifiers: { fbclid: "a\u0000b" } }],
    ["identificador longo demais", { ...base, identifiers: { fbclid: "x".repeat(513) } }],
  ])("rejeita: %s", (_name, body) => {
    expect(sessionRequestSchema.safeParse(body).success).toBe(false);
  });

  it("descarta a chave __proto__ de customFields, sem poluir o protótipo", () => {
    const body = JSON.parse('{"sessionId":"s","pageUrl":"https://a.com","customFields":{"__proto__":{"polluted":true},"source":"facebook"}}');
    const parsed = sessionRequestSchema.parse(body);
    expect(Object.keys(parsed.customFields ?? {})).toEqual(["source"]);
    expect(Object.hasOwn(parsed.customFields ?? {}, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("normaliza e gera avisos para e-mail e telefone inválidos", () => {
    const parsed = sessionRequestSchema.parse({
      ...base,
      customer: { email: "ruim", phone: "11999999999" },
    });
    const normalized = normalizeSessionRequest(parsed);
    expect(normalized.customerEmail).toBeNull();
    expect(normalized.customerPhone).toBeNull();
    expect(normalized.warnings).toHaveLength(2);
  });
});
