import { describe, expect, it } from "vitest";
import { mergeSession, type SessionState } from "../../src/modules/tracking/merge.js";
import { IDENTIFIER_FIELDS, type Identifiers } from "../../src/modules/tracking/normalize.js";

const emptyIdentifiers = (): Identifiers =>
  Object.fromEntries(IDENTIFIER_FIELDS.map((f) => [f, null])) as Identifiers;

const state = (overrides: Partial<SessionState> & { ids?: Partial<Identifiers> } = {}): SessionState => ({
  pageUrl: "https://a.com/1",
  customFields: null,
  customerEmail: null,
  customerPhone: null,
  ...overrides,
  identifiers: { ...emptyIdentifiers(), ...overrides.ids },
});

describe("mergeSession (ADR-004, ADR-014, ADR-022)", () => {
  it("complementa identificador ausente", () => {
    const r = mergeSession(state(), state({ ids: { gclid: "g1" } }));
    expect(r.next.identifiers.gclid).toBe("g1");
    expect(r.changes).toEqual([{ field: "identifiers.gclid", value: "g1" }]);
    expect(r.conflicts).toEqual([]);
  });

  it("nulo recebido nunca apaga valor existente", () => {
    const r = mergeSession(state({ ids: { fbclid: "f1" } }), state());
    expect(r.next.identifiers.fbclid).toBe("f1");
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("mesmo valor não gera mudança nem conflito", () => {
    const r = mergeSession(state({ ids: { fbclid: "f1" } }), state({ ids: { fbclid: "f1" } }));
    expect(r.changes).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("valor diferente em campo preenchido: first-write-wins e registra conflito", () => {
    const r = mergeSession(state({ ids: { fbclid: "original" } }), state({ ids: { fbclid: "outro" } }));
    expect(r.next.identifiers.fbclid).toBe("original");
    expect(r.conflicts).toEqual([{ field: "identifiers.fbclid", kept: "original", received: "outro" }]);
  });

  it("e-mail e telefone: complementa quando nulos, conflito quando divergem", () => {
    const first = mergeSession(state(), state({ customerEmail: "a@a.com", customerPhone: "+5511999999999" }));
    expect(first.next.customerEmail).toBe("a@a.com");
    const second = mergeSession(first.next, state({ customerEmail: "b@b.com" }));
    expect(second.next.customerEmail).toBe("a@a.com");
    expect(second.conflicts.map((c) => c.field)).toEqual(["customer.email"]);
  });

  it("customFields ausente é preenchido uma vez", () => {
    const r = mergeSession(state(), state({ customFields: { source: "facebook" } }));
    expect(r.next.customFields).toEqual({ source: "facebook" });
    expect(r.changes.map((c) => c.field)).toEqual(["customFields"]);
  });

  it("customFields é atômico: objeto diferente vira conflito e NÃO é mesclado por chave", () => {
    const kept = { source: "facebook", campaign: "bf" };
    const r = mergeSession(state({ customFields: kept }), state({ customFields: { source: "google", extra: "x" } }));
    expect(r.next.customFields).toEqual(kept);
    expect(r.next.customFields).not.toHaveProperty("extra");
    expect(r.conflicts.map((c) => c.field)).toEqual(["customFields"]);
  });

  it("customFields igual com ordem de chaves diferente não é conflito", () => {
    const r = mergeSession(
      state({ customFields: { a: "1", b: "2" } }),
      state({ customFields: { b: "2", a: "1" } }),
    );
    expect(r.conflicts).toEqual([]);
  });

  it("preserva a primeira pageUrl", () => {
    const r = mergeSession(state({ pageUrl: "https://a.com/1" }), state({ pageUrl: "https://a.com/2" }));
    expect(r.next.pageUrl).toBe("https://a.com/1");
    expect(r.conflicts).toEqual([]);
  });
});
