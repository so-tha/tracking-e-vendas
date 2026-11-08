import { describe, expect, it } from "vitest";
import { maskDeep } from "../../src/modules/support/mask.js";
import { sha256Hex } from "../../src/shared/pii.js";

describe("maskDeep (ADR-019)", () => {
  it("mascara e-mail, telefone, documento, nome e IP em qualquer profundidade", () => {
    const masked = maskDeep({
      customer: { name: "Maria Silva", email: "maria@email.com", phone: "+5511999999999", document: "12345678900", ip: "1.2.3.4" },
      lista: [{ email: "outro@email.com" }],
    }) as any;
    expect(masked.customer).toEqual({ name: "M***", email: "m***@email.com", phone: "**********9999", document: "***", ip: "***" });
    expect(masked.lista[0].email).toBe("o***@email.com");
  });

  it("não mexe em hashes SHA-256: o hash é a prova do que foi enviado", () => {
    const hash = sha256Hex("cliente@email.com");
    expect(maskDeep({ email: hash, phone: hash, em: [hash], ph: [hash] })).toEqual({ email: hash, phone: hash, em: [hash], ph: [hash] });
  });

  it("não depende de maiúsculas e minúsculas na chave", () => {
    expect(maskDeep({ Email: "maria@email.com", PHONE: "+5511999999999" })).toEqual({ Email: "m***@email.com", PHONE: "**********9999" });
  });

  it("preserva o que não é pessoal, inclusive tipos não textuais", () => {
    const value = { orderId: "ORD-1", amount: 255, ok: true, nothing: null, fbclid: "fb-click-id", email: null, nested: { n: 1 } };
    expect(maskDeep(value)).toEqual(value);
  });

  it("não altera o objeto original", () => {
    const original = { customer: { email: "maria@email.com" } };
    maskDeep(original);
    expect(original.customer.email).toBe("maria@email.com");
  });

  it("aceita null, undefined e valores simples", () => {
    expect(maskDeep(null)).toBeNull();
    expect(maskDeep(undefined)).toBeUndefined();
    expect(maskDeep("texto")).toBe("texto");
    expect(maskDeep(5)).toBe(5);
  });
});
