import { describe, expect, it } from "vitest";
import {
  resolveAttribution,
  type AttributionEvidence,
  type SessionLookup,
  type SessionRecord,
} from "../../src/modules/attribution/resolve.js";
import { IDENTIFIER_FIELDS, type IdentifierField, type Identifiers } from "../../src/modules/tracking/normalize.js";

const RECEIVED = new Date("2026-01-10T12:00:00.000Z");
const hoursBefore = (h: number) => new Date(RECEIVED.getTime() - h * 3_600_000);

const emptyIds = (): Identifiers => Object.fromEntries(IDENTIFIER_FIELDS.map((f) => [f, null])) as Identifiers;
const ids = (partial: Partial<Identifiers> = {}): Identifiers => ({ ...emptyIds(), ...partial });

let counter = 0;
function session(sessionId: string, overrides: Partial<Omit<SessionRecord, "identifiers">> & { ids?: Partial<Identifiers> } = {}): SessionRecord {
  counter++;
  const { ids: idOverrides, ...rest } = overrides;
  return {
    id: `uuid-${counter}-${sessionId}`,
    sessionId,
    customFields: null,
    customerEmail: null,
    firstSeenAt: hoursBefore(1),
    ...rest,
    identifiers: ids(idOverrides),
  };
}

/** Banco em memória com a mesma semântica das consultas reais. */
function memory(sessions: SessionRecord[]): SessionLookup {
  return {
    findBySessionId: async (sessionId) => sessions.find((s) => s.sessionId === sessionId) ?? null,
    findByIdentifier: async (field: IdentifierField, value) => sessions.filter((s) => s.identifiers[field] === value),
    findByCustomerEmail: async (email, from, to) =>
      sessions.filter((s) => s.customerEmail === email && s.firstSeenAt >= from && s.firstSeenAt <= to),
  };
}

function evidence(overrides: Partial<Omit<AttributionEvidence, "identifiers">> & { ids?: Partial<Identifiers> } = {}): AttributionEvidence {
  const { ids: idOverrides, ...rest } = overrides;
  return { sessionId: null, customerEmail: null, customFields: null, receivedAt: RECEIVED, ...rest, identifiers: ids(idOverrides) };
}

const resolve = (e: AttributionEvidence, sessions: SessionRecord[], windowHours = 24) =>
  resolveAttribution(e, memory(sessions), { windowHours });

describe("nível 1: sessionId", () => {
  it("atribui pela sessão existente (caso de teste 1)", async () => {
    const s = session("session_123");
    const r = await resolve(evidence({ sessionId: "session_123" }), [s]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 1, method: "SESSION_ID", sessionRefId: s.id, sessionId: "session_123", unattributedReason: null });
  });

  it("sessionId inexistente cai para os níveis seguintes", async () => {
    const s = session("outra", { ids: { gclid: "g1" } });
    const r = await resolve(evidence({ sessionId: "nao-existe", ids: { gclid: "g1" } }), [s]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 3 });
  });

  it("sessionId inexistente sem outra evidência: não atribuída por NO_MATCHING_SESSION", async () => {
    const r = await resolve(evidence({ sessionId: "nao-existe" }), [session("outra")]);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", level: null, sessionRefId: null, unattributedReason: "NO_MATCHING_SESSION" });
  });

  it("o nível 1 vence as demais evidências, e o conflito é registrado (ADR-012)", async () => {
    const a = session("A");
    const b = session("B", { ids: { fbclid: "f-b" }, customerEmail: "c@e.com" });
    const r = await resolve(evidence({ sessionId: "A", ids: { fbclid: "f-b" }, customerEmail: "c@e.com" }), [a, b]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 1, sessionId: "A" });
    expect(r.alerts).toEqual([
      {
        code: "ATTRIBUTION_CONFLICT",
        details: [
          { kind: "OTHER_SESSION_EVIDENCE", level: 3, method: "CLICK_ID", sessionIds: ["B"] },
          { kind: "OTHER_SESSION_EVIDENCE", level: 4, method: "CUSTOMER_WINDOW", sessionIds: ["B"] },
        ],
      },
    ]);
  });
});

describe("nível 2: identificadores próprios (utmifyId, redtrackClickId)", () => {
  it.each(["utmifyId", "redtrackClickId"] as const)("atribui por %s", async (field) => {
    const s = session("S", { ids: { [field]: "v1" } });
    const r = await resolve(evidence({ ids: { [field]: "v1" } }), [s]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 2, method: "PLATFORM_IDENTIFIER", sessionId: "S" });
  });

  it("duas sessões com o mesmo identificador: não atribui e NÃO cai para o nível seguinte (ADR-020)", async () => {
    const a = session("A", { ids: { utmifyId: "u1" } });
    const b = session("B", { ids: { utmifyId: "u1", gclid: "g1" } });
    const r = await resolve(evidence({ ids: { utmifyId: "u1", gclid: "g1" } }), [a, b]);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "AMBIGUOUS_PLATFORM_IDENTIFIER", sessionRefId: null });
  });

  it("utmifyId e redtrackClickId apontando para sessões diferentes: ambiguidade no mesmo nível", async () => {
    const a = session("A", { ids: { utmifyId: "u1" } });
    const b = session("B", { ids: { redtrackClickId: "r1" } });
    const r = await resolve(evidence({ ids: { utmifyId: "u1", redtrackClickId: "r1" } }), [a, b]);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "AMBIGUOUS_PLATFORM_IDENTIFIER" });
  });

  it("os dois identificadores apontando para a mesma sessão não são ambiguidade", async () => {
    const a = session("A", { ids: { utmifyId: "u1", redtrackClickId: "r1" } });
    const r = await resolve(evidence({ ids: { utmifyId: "u1", redtrackClickId: "r1" } }), [a]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 2, sessionId: "A" });
  });

  it("o nível 2 vence o nível 3 e o conflito é registrado", async () => {
    const a = session("A", { ids: { utmifyId: "u1" } });
    const b = session("B", { ids: { fbclid: "f1" } });
    const r = await resolve(evidence({ ids: { utmifyId: "u1", fbclid: "f1" } }), [a, b]);
    expect(r).toMatchObject({ level: 2, sessionId: "A" });
    expect(r.alerts[0]).toMatchObject({ code: "ATTRIBUTION_CONFLICT" });
  });
});

describe("nível 3: click IDs", () => {
  it.each(["fbclid", "fbc", "gclid", "gbraid", "wbraid", "ttclid"] as const)("atribui por %s", async (field) => {
    const s = session("S", { ids: { [field]: "v1" } });
    const r = await resolve(evidence({ ids: { [field]: "v1" } }), [s]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 3, method: "CLICK_ID", sessionId: "S" });
  });

  it("fbp e ttp nunca decidem a atribuição, mesmo casando com uma única sessão (ADR-013)", async () => {
    const s = session("S", { ids: { fbp: "fb.1.cookie", ttp: "tt-cookie" } });
    const r = await resolve(evidence({ ids: { fbp: "fb.1.cookie", ttp: "tt-cookie" } }), [s]);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "NO_EVIDENCE" });
    expect(r.trace).toContainEqual({ step: "BROWSER_COOKIES", outcome: "NOT_USED", fields: ["fbp", "ttp"] });
  });

  it("fbp ao lado de um click ID válido não atrapalha", async () => {
    const s = session("S", { ids: { fbp: "c", fbclid: "f1" } });
    const r = await resolve(evidence({ ids: { fbp: "c", fbclid: "f1" } }), [s]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 3 });
  });

  it("o mesmo click ID em duas sessões: não atribui (ex.: recarga da página)", async () => {
    const r = await resolve(evidence({ ids: { fbclid: "f1" } }), [session("A", { ids: { fbclid: "f1" } }), session("B", { ids: { fbclid: "f1" } })]);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "AMBIGUOUS_CLICK_ID" });
  });

  it("click IDs diferentes para sessões diferentes: ambiguidade no mesmo nível", async () => {
    const r = await resolve(evidence({ ids: { fbclid: "f1", gclid: "g1" } }), [session("A", { ids: { fbclid: "f1" } }), session("B", { ids: { gclid: "g1" } })]);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "AMBIGUOUS_CLICK_ID" });
  });

  it("identificadores diferenciam maiúsculas de minúsculas", async () => {
    const r = await resolve(evidence({ ids: { fbclid: "ABC" } }), [session("S", { ids: { fbclid: "abc" } })]);
    expect(r.result).toBe("UNATTRIBUTED");
  });

  it("o nível 3 vence o nível 4, com conflito registrado", async () => {
    const a = session("A", { ids: { gclid: "g1" } });
    const b = session("B", { customerEmail: "c@e.com" });
    const r = await resolve(evidence({ ids: { gclid: "g1" }, customerEmail: "c@e.com" }), [a, b]);
    expect(r).toMatchObject({ level: 3, sessionId: "A" });
    expect(r.alerts[0]).toMatchObject({ code: "ATTRIBUTION_CONFLICT", details: [{ kind: "OTHER_SESSION_EVIDENCE", level: 4, sessionIds: ["B"] }] });
  });
});

describe("nível 4: cliente e janela de tempo (ADR-003, ADR-013)", () => {
  const email = "cliente@email.com";

  it("atribui quando há exatamente uma sessão do cliente dentro da janela", async () => {
    const s = session("S", { customerEmail: email, firstSeenAt: hoursBefore(5) });
    const r = await resolve(evidence({ customerEmail: email }), [s]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 4, method: "CUSTOMER_WINDOW", sessionId: "S" });
  });

  it("duas sessões do mesmo cliente na janela: não atribui (caso de teste 8)", async () => {
    const r = await resolve(evidence({ customerEmail: email }), [
      session("A", { customerEmail: email, firstSeenAt: hoursBefore(5) }),
      session("B", { customerEmail: email, firstSeenAt: hoursBefore(2) }),
    ]);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", sessionRefId: null, unattributedReason: "AMBIGUOUS_CUSTOMER_WINDOW" });
  });

  it("uma sessão dentro e outra fora da janela: atribui à de dentro", async () => {
    const r = await resolve(evidence({ customerEmail: email }), [
      session("velha", { customerEmail: email, firstSeenAt: hoursBefore(48) }),
      session("nova", { customerEmail: email, firstSeenAt: hoursBefore(3) }),
    ]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", sessionId: "nova" });
  });

  it("os limites da janela são inclusivos, e um milissegundo além fica de fora", async () => {
    const at = (offsetMs: number) => session("S", { customerEmail: email, firstSeenAt: new Date(hoursBefore(24).getTime() + offsetMs) });
    expect((await resolve(evidence({ customerEmail: email }), [at(0)])).result).toBe("ATTRIBUTED");
    expect((await resolve(evidence({ customerEmail: email }), [at(-1)])).result).toBe("UNATTRIBUTED");
    const exactlyAtOrder = session("S", { customerEmail: email, firstSeenAt: RECEIVED });
    expect((await resolve(evidence({ customerEmail: email }), [exactlyAtOrder])).result).toBe("ATTRIBUTED");
  });

  it("sessão criada depois do pedido não entra (limitação C-04)", async () => {
    const late = session("S", { customerEmail: email, firstSeenAt: new Date(RECEIVED.getTime() + 1) });
    expect((await resolve(evidence({ customerEmail: email }), [late])).result).toBe("UNATTRIBUTED");
  });

  it("respeita a janela configurada", async () => {
    const s = session("S", { customerEmail: email, firstSeenAt: hoursBefore(10) });
    expect((await resolve(evidence({ customerEmail: email }), [s], 24)).result).toBe("ATTRIBUTED");
    expect((await resolve(evidence({ customerEmail: email }), [s], 6)).result).toBe("UNATTRIBUTED");
  });

  it("cliente de outro e-mail não casa", async () => {
    const r = await resolve(evidence({ customerEmail: email }), [session("S", { customerEmail: "outro@email.com" })]);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", unattributedReason: "NO_MATCHING_SESSION" });
  });
});

describe("sem evidência (caso de teste 2)", () => {
  it("venda sem tracking: não atribuída por NO_EVIDENCE", async () => {
    const r = await resolve(evidence(), [session("qualquer", { customerEmail: "c@e.com", ids: { fbclid: "f" } })]);
    expect(r).toMatchObject({
      result: "UNATTRIBUTED", level: null, method: null, sessionRefId: null, customFields: null,
      customFieldsSource: "NONE", affiliate: null, identifiers: {}, alerts: [], unattributedReason: "NO_EVIDENCE",
    });
  });
});

describe("customFields (ADR-011, caso de teste 4)", () => {
  const sessionFields = { source: "facebook", campaign: "black-friday", affiliateCode: "AFF-001" };

  it("webhook sem customFields recupera os da sessão, com origem SESSION", async () => {
    const r = await resolve(evidence({ sessionId: "S" }), [session("S", { customFields: sessionFields })]);
    expect(r.customFields).toEqual(sessionFields);
    expect(r.customFieldsSource).toBe("SESSION");
  });

  it("webhook com customFields vazio também recupera os da sessão", async () => {
    const r = await resolve(evidence({ sessionId: "S", customFields: {} }), [session("S", { customFields: sessionFields })]);
    expect(r.customFieldsSource).toBe("SESSION");
  });

  it("objeto do webhook vence e NÃO é mesclado por chave com o da sessão", async () => {
    const webhookFields = { source: "google" };
    const r = await resolve(evidence({ sessionId: "S", customFields: webhookFields }), [session("S", { customFields: sessionFields })]);
    expect(r.customFields).toEqual({ source: "google" });
    expect(r.customFields).not.toHaveProperty("campaign");
    expect(r.customFields).not.toHaveProperty("affiliateCode");
    expect(r.customFieldsSource).toBe("WEBHOOK");
    expect(r.alerts).toContainEqual({ code: "CUSTOM_FIELDS_DIVERGENCE", details: { used: "WEBHOOK" } });
  });

  it("objetos iguais com chaves em outra ordem não geram divergência", async () => {
    const r = await resolve(evidence({ sessionId: "S", customFields: { b: "2", a: "1" } }), [session("S", { customFields: { a: "1", b: "2" } })]);
    expect(r.alerts).toEqual([]);
  });

  it("sem customFields em lugar nenhum: nada é inventado (RF-07)", async () => {
    const r = await resolve(evidence({ sessionId: "S" }), [session("S")]);
    expect(r).toMatchObject({ customFields: null, customFieldsSource: "NONE", affiliate: null });
  });

  it("venda não atribuída usa os customFields do próprio webhook, sem inventar", async () => {
    const r = await resolve(evidence({ customFields: { source: "facebook" } }), []);
    expect(r).toMatchObject({ result: "UNATTRIBUTED", customFields: { source: "facebook" }, customFieldsSource: "WEBHOOK" });
  });
});

describe("identificadores efetivos (ADR-021, caso de teste 7)", () => {
  it("com sessão atribuída, usa os identificadores da sessão com origem SESSION", async () => {
    const s = session("S", { ids: { fbclid: "f1", fbc: "c1", fbp: "p1", gclid: "g1", ttclid: "t1", ttp: "tp1", redtrackClickId: "r1", utmifyId: "u1" } });
    const r = await resolve(evidence({ sessionId: "S" }), [s]);
    expect(r.identifiers).toEqual({
      fbclid: { value: "f1", source: "SESSION" }, fbc: { value: "c1", source: "SESSION" },
      fbp: { value: "p1", source: "SESSION" }, gclid: { value: "g1", source: "SESSION" },
      ttclid: { value: "t1", source: "SESSION" }, ttp: { value: "tp1", source: "SESSION" },
      redtrackClickId: { value: "r1", source: "SESSION" }, utmifyId: { value: "u1", source: "SESSION" },
    });
  });

  it("com sessão atribuída, identificadores divergentes do webhook NÃO são usados e geram conflito", async () => {
    const s = session("S", { ids: { fbclid: "da-sessao" } });
    const r = await resolve(evidence({ sessionId: "S", ids: { fbclid: "do-webhook", gclid: "so-no-webhook" } }), [s]);
    expect(r.identifiers).toEqual({ fbclid: { value: "da-sessao", source: "SESSION" } });
    expect(r.alerts).toContainEqual({ code: "ATTRIBUTION_CONFLICT", details: [{ kind: "IDENTIFIER_MISMATCH", field: "fbclid" }] });
  });

  it("sem sessão, usa os identificadores do webhook com origem WEBHOOK, inclusive fbp e ttp", async () => {
    const r = await resolve(evidence({ ids: { gclid: "g-web", fbp: "p-web" } }), []);
    expect(r.result).toBe("UNATTRIBUTED");
    expect(r.identifiers).toEqual({ gclid: { value: "g-web", source: "WEBHOOK" }, fbp: { value: "p-web", source: "WEBHOOK" } });
  });

  it("e-mail do webhook diferente do da sessão gera conflito", async () => {
    const r = await resolve(evidence({ sessionId: "S", customerEmail: "a@a.com" }), [session("S", { customerEmail: "b@b.com" })]);
    expect(r).toMatchObject({ result: "ATTRIBUTED", level: 1 });
    expect(r.alerts).toContainEqual({ code: "ATTRIBUTION_CONFLICT", details: [{ kind: "EMAIL_MISMATCH" }] });
  });
});

describe("affiliateCode (ADR-018)", () => {
  it("guarda código, origem e nível de evidência", async () => {
    const r = await resolve(evidence({ sessionId: "S" }), [session("S", { customFields: { affiliateCode: " AFF-001 " } })]);
    expect(r.affiliate).toEqual({ code: "AFF-001", source: "SESSION", evidenceLevel: 1 });
  });

  it("origem WEBHOOK com atribuição pelo nível 4 registra o nível 4", async () => {
    const s = session("S", { customerEmail: "c@e.com" });
    const r = await resolve(evidence({ customerEmail: "c@e.com", customFields: { affiliateCode: "AFF-9" } }), [s]);
    expect(r.affiliate).toEqual({ code: "AFF-9", source: "WEBHOOK", evidenceLevel: 4 });
  });

  it("venda não atribuída guarda o afiliado do webhook com evidência nula (não será enviado)", async () => {
    const r = await resolve(evidence({ customFields: { affiliateCode: "AFF-9" } }), []);
    expect(r.affiliate).toEqual({ code: "AFF-9", source: "WEBHOOK", evidenceLevel: null });
  });

  it.each([[123], [""], ["   "], [null], [{ a: 1 }]])("ignora affiliateCode que não é texto útil: %j", async (value) => {
    const r = await resolve(evidence({ sessionId: "S" }), [session("S", { customFields: { affiliateCode: value } })]);
    expect(r.affiliate).toBeNull();
  });
});

describe("rastro da decisão", () => {
  it("lista o resultado de cada nível, sem valores sensíveis", async () => {
    const s = session("S", { customerEmail: "segredo@email.com", ids: { fbclid: "VALOR-SECRETO-123" } });
    const r = await resolve(
      evidence({ sessionId: "S", ids: { fbclid: "VALOR-SECRETO-123" }, customerEmail: "segredo@email.com" }),
      [s],
    );
    expect(r.trace.map((t) => [t.step, t.outcome])).toEqual([
      ["LEVEL_1_SESSION_ID", "FOUND"],
      ["LEVEL_2_PLATFORM_IDENTIFIER", "ABSENT"],
      ["LEVEL_3_CLICK_ID", "FOUND"],
      ["LEVEL_4_CUSTOMER_WINDOW", "FOUND"],
    ]);
    const serialized = JSON.stringify(r.trace) + JSON.stringify(r.alerts);
    expect(serialized).not.toContain("VALOR-SECRETO-123");
    expect(serialized).not.toContain("segredo@email.com");
  });

  it("é determinístico: as mesmas entradas dão o mesmo resultado", async () => {
    const sessions = [session("A", { customerEmail: "c@e.com" }), session("B", { customerEmail: "c@e.com" })];
    const e = evidence({ customerEmail: "c@e.com" });
    expect(await resolve(e, sessions)).toEqual(await resolve(e, sessions));
  });
});
