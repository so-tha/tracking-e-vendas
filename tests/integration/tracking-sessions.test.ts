import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma, resetDatabase } from "./helpers/db.js";

const prisma = createTestPrisma();
const app = createApp({ prisma, logger: createLogger({ level: "silent" }) });

beforeEach(async () => {
  await resetDatabase(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

// Exemplo exato do documento original (seção 3).
const documentExample = {
  sessionId: "session_123",
  pageUrl: "https://checkout.exemplo.com/produto",
  customFields: { source: "facebook", campaign: "black-friday", content: "criativo-01", affiliateCode: "AFF-001" },
  identifiers: {
    fbclid: "fb-click-id", fbc: "meta-fbc", fbp: "meta-fbp",
    gclid: "google-click-id", gbraid: null, wbraid: null,
    ttclid: "tiktok-click-id", ttp: "tiktok-cookie",
    redtrackClickId: "redtrack-click-id", utmifyId: "utmify-id",
  },
  customer: { email: "cliente@email.com", phone: "+5511999999999" },
};

const post = (body: unknown) => request(app).post("/tracking/sessions").send(body as object);
const load = (sessionId = "session_123") => prisma.trackingSession.findUniqueOrThrow({ where: { sessionId } });

describe("POST /tracking/sessions: criação", () => {
  it("cria a sessão com o exemplo do documento e responde 201", async () => {
    const res = await post(documentExample);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sessionId: "session_123", created: true, complementedFields: [], conflictFields: [], warnings: [],
    });

    const row = await load();
    expect(row).toMatchObject({
      pageUrl: documentExample.pageUrl,
      customFields: documentExample.customFields,
      fbclid: "fb-click-id", fbc: "meta-fbc", fbp: "meta-fbp", gclid: "google-click-id",
      gbraid: null, wbraid: null, ttclid: "tiktok-click-id", ttp: "tiktok-cookie",
      redtrackClickId: "redtrack-click-id", utmifyId: "utmify-id",
      customerEmail: "cliente@email.com", customerPhone: "+5511999999999",
    });
  });

  it("aceita sessão mínima, sem identifiers, customFields nem customer", async () => {
    const res = await post({ sessionId: "s-min", pageUrl: "https://a.com" });
    expect(res.status).toBe(201);
    const row = await load("s-min");
    expect(row.customFields).toBeNull();
    expect(row.fbclid).toBeNull();
  });

  it("normaliza e-mail, telefone e identificadores vazios", async () => {
    const res = await post({
      sessionId: "s-norm", pageUrl: "https://a.com",
      identifiers: { fbclid: "  FbClid-AbC  ", gclid: "   ", ttp: "" },
      customer: { email: "  Cliente@Email.COM ", phone: "+55 (11) 99999-9999" },
    });
    expect(res.status).toBe(201);
    const row = await load("s-norm");
    expect(row.fbclid).toBe("FbClid-AbC");
    expect(row.gclid).toBeNull();
    expect(row.ttp).toBeNull();
    expect(row.customerEmail).toBe("cliente@email.com");
    expect(row.customerPhone).toBe("+5511999999999");
  });

  it("trata customFields vazio como ausente", async () => {
    await post({ sessionId: "s-empty", pageUrl: "https://a.com", customFields: {} });
    expect((await load("s-empty")).customFields).toBeNull();
  });

  it("ignora telefone e e-mail inválidos com aviso, sem perder a sessão", async () => {
    const res = await post({
      sessionId: "s-warn", pageUrl: "https://a.com",
      identifiers: { fbclid: "f1" },
      customer: { email: "ruim", phone: "11999999999" },
    });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toHaveLength(2);
    const row = await load("s-warn");
    expect(row.fbclid).toBe("f1");
    expect(row.customerEmail).toBeNull();
    expect(row.customerPhone).toBeNull();
  });
});

describe("POST /tracking/sessions: dados fora do padrão não são salvos em lugar nenhum", () => {
  it("e-mail e telefone inválidos não aparecem na sessão nem no histórico de revisões", async () => {
    await post({
      sessionId: "s-lixo", pageUrl: "https://a.com",
      customer: { email: "EMAIL-INVALIDO-XYZ", phone: "TELEFONE-INVALIDO-123" },
    });
    const everything = JSON.stringify({
      session: await load("s-lixo"),
      revisions: await prisma.trackingSessionRevision.findMany(),
    });
    expect(everything).not.toContain("EMAIL-INVALIDO-XYZ");
    expect(everything).not.toContain("TELEFONE-INVALIDO-123");
    // O aviso fica registrado, sem o valor.
    expect(everything).toContain("customer.email ignorado");
  });

  it("o histórico guarda os valores normalizados, e não o corpo bruto", async () => {
    await post({
      sessionId: "s-norm2", pageUrl: "https://a.com",
      identifiers: { fbclid: "  AbC  " },
      customer: { email: "  Cliente@Email.COM ", phone: "+55 (11) 99999-9999" },
    });
    const [revision] = await prisma.trackingSessionRevision.findMany();
    expect(revision?.incomingPayload).toMatchObject({
      identifiers: { fbclid: "AbC" },
      customer: { email: "cliente@email.com", phone: "+5511999999999" },
    });
  });
});

describe("POST /tracking/sessions: upsert controlado (ADR-004, ADR-014, ADR-022)", () => {
  it("repetir o mesmo envio responde 200 sem mudanças, mas registra a revisão", async () => {
    await post(documentExample);
    const res = await post(documentExample);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, complementedFields: [], conflictFields: [] });
    expect(await prisma.trackingSession.count()).toBe(1);
    expect(await prisma.trackingSessionRevision.count()).toBe(2);
  });

  it("complementa identificador ausente sem tocar nos existentes", async () => {
    await post({ sessionId: "s1", pageUrl: "https://a.com", identifiers: { fbclid: "f1" } });
    const res = await post({ sessionId: "s1", pageUrl: "https://a.com", identifiers: { gclid: "g1" } });
    expect(res.body.complementedFields).toEqual(["identifiers.gclid"]);
    const row = await load("s1");
    expect(row.fbclid).toBe("f1");
    expect(row.gclid).toBe("g1");
  });

  it("nulo recebido não apaga identificador existente", async () => {
    await post({ sessionId: "s1", pageUrl: "https://a.com", identifiers: { fbclid: "f1" } });
    const res = await post({ sessionId: "s1", pageUrl: "https://a.com", identifiers: { fbclid: null } });
    expect(res.status).toBe(200);
    expect(res.body.conflictFields).toEqual([]);
    expect((await load("s1")).fbclid).toBe("f1");
  });

  it("valor divergente: preserva o original, registra o conflito e NÃO vaza valores na resposta", async () => {
    await post({ sessionId: "s1", pageUrl: "https://a.com", identifiers: { fbclid: "ORIGINAL-SECRETO" } });
    const res = await post({ sessionId: "s1", pageUrl: "https://a.com", identifiers: { fbclid: "TENTATIVA-DE-SEQUESTRO" } });

    expect(res.status).toBe(200);
    expect(res.body.conflictFields).toEqual(["identifiers.fbclid"]);
    expect(JSON.stringify(res.body)).not.toContain("ORIGINAL-SECRETO");
    expect(JSON.stringify(res.body)).not.toContain("TENTATIVA-DE-SEQUESTRO");

    expect((await load("s1")).fbclid).toBe("ORIGINAL-SECRETO");

    const revisions = await prisma.trackingSessionRevision.findMany({ orderBy: { receivedAt: "asc" } });
    expect(revisions[1]?.conflicts).toEqual([
      { field: "identifiers.fbclid", kept: "ORIGINAL-SECRETO", received: "TENTATIVA-DE-SEQUESTRO" },
    ]);
  });

  it("customFields é atômico: um segundo objeto diferente vira conflito e não é mesclado", async () => {
    await post({ sessionId: "s1", pageUrl: "https://a.com", customFields: { source: "facebook", affiliateCode: "AFF-001" } });
    const res = await post({
      sessionId: "s1", pageUrl: "https://a.com",
      customFields: { source: "google", affiliateCode: "AFF-999", extra: "x" },
    });
    expect(res.body.conflictFields).toEqual(["customFields"]);
    expect((await load("s1")).customFields).toEqual({ source: "facebook", affiliateCode: "AFF-001" });
  });

  it("customFields ausente na criação pode ser preenchido depois, uma única vez", async () => {
    await post({ sessionId: "s1", pageUrl: "https://a.com" });
    const first = await post({ sessionId: "s1", pageUrl: "https://a.com", customFields: { source: "facebook" } });
    expect(first.body.complementedFields).toEqual(["customFields"]);
    const second = await post({ sessionId: "s1", pageUrl: "https://a.com", customFields: { source: "tiktok" } });
    expect(second.body.conflictFields).toEqual(["customFields"]);
    expect((await load("s1")).customFields).toEqual({ source: "facebook" });
  });

  it("e-mail e telefone: complementa quando nulos e registra conflito quando divergem", async () => {
    await post({ sessionId: "s1", pageUrl: "https://a.com" });
    const add = await post({ sessionId: "s1", pageUrl: "https://a.com", customer: { email: "a@a.com" } });
    expect(add.body.complementedFields).toEqual(["customer.email"]);
    const diverge = await post({ sessionId: "s1", pageUrl: "https://a.com", customer: { email: "b@b.com" } });
    expect(diverge.body.conflictFields).toEqual(["customer.email"]);
    expect((await load("s1")).customerEmail).toBe("a@a.com");
  });

  it("preserva a primeira pageUrl e guarda as demais no histórico", async () => {
    await post({ sessionId: "s1", pageUrl: "https://a.com/landing" });
    const res = await post({ sessionId: "s1", pageUrl: "https://a.com/checkout" });
    expect(res.body.conflictFields).toEqual([]);
    expect((await load("s1")).pageUrl).toBe("https://a.com/landing");

    const revisions = await prisma.trackingSessionRevision.findMany({ orderBy: { receivedAt: "asc" } });
    expect(revisions.map((r) => (r.incomingPayload as { pageUrl: string }).pageUrl)).toEqual([
      "https://a.com/landing",
      "https://a.com/checkout",
    ]);
  });

  it("atualiza lastSeenAt e mantém firstSeenAt", async () => {
    const times = [new Date("2026-01-01T10:00:00Z"), new Date("2026-01-01T11:00:00Z")];
    let i = 0;
    const clocked = createApp({ prisma, logger: createLogger({ level: "silent" }), now: () => times[i++]! });
    await request(clocked).post("/tracking/sessions").send({ sessionId: "s1", pageUrl: "https://a.com" });
    await request(clocked).post("/tracking/sessions").send({ sessionId: "s1", pageUrl: "https://a.com" });
    const row = await load("s1");
    expect(row.firstSeenAt).toEqual(times[0]);
    expect(row.lastSeenAt).toEqual(times[1]);
  });
});

describe("POST /tracking/sessions: validação", () => {
  it.each([
    ["sem sessionId", { pageUrl: "https://a.com" }],
    ["pageUrl com esquema perigoso", { sessionId: "s", pageUrl: "javascript:alert(1)" }],
    ["customFields não objeto", { sessionId: "s", pageUrl: "https://a.com", customFields: "x" }],
    ["identificador numérico", { sessionId: "s", pageUrl: "https://a.com", identifiers: { fbclid: 1 } }],
  ])("responde 400 e não grava nada: %s", async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(await prisma.trackingSession.count()).toBe(0);
  });

  it("não ecoa os valores recebidos nos detalhes do erro", async () => {
    const res = await post({ sessionId: "s", pageUrl: "javascript:SEGREDO-NA-URL" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("SEGREDO-NA-URL");
  });

  it("responde 400 quando não há corpo JSON", async () => {
    const res = await request(app).post("/tracking/sessions");
    expect(res.status).toBe(400);
  });
});

describe("POST /tracking/sessions: concorrência", () => {
  it("20 envios simultâneos do mesmo sessionId: um 201, os demais 200, uma única sessão", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => post({ sessionId: "s-conc", pageUrl: "https://a.com" })),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(19);
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await prisma.trackingSession.count()).toBe(1);
    expect(await prisma.trackingSessionRevision.count()).toBe(20);
  });

  it("10 envios simultâneos com fbclid diferentes: exatamente um valor vence e 9 conflitos são registrados", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        post({ sessionId: "s-race", pageUrl: "https://a.com", identifiers: { fbclid: `fb-${n}` } }),
      ),
    );
    expect(responses.every((r) => r.status === 200 || r.status === 201)).toBe(true);

    const winner = (await load("s-race")).fbclid;
    expect(winner).toMatch(/^fb-\d$/);

    const revisions = await prisma.trackingSessionRevision.findMany();
    const conflicts = revisions.flatMap((r) => r.conflicts as { kept: string; received: string }[]);
    expect(conflicts).toHaveLength(9);
    expect(conflicts.every((c) => c.kept === winner)).toBe(true);
    expect(new Set(conflicts.map((c) => c.received)).size).toBe(9);
  });

  it("customFields diferentes em paralelo: um objeto inteiro vence, sem mistura de chaves", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        post({ sessionId: "s-cf", pageUrl: "https://a.com", customFields: { source: `src-${n}`, [`only-${n}`]: "x" } }),
      ),
    );
    const stored = (await load("s-cf")).customFields as Record<string, string>;
    expect(Object.keys(stored)).toHaveLength(2);
    const n = stored["source"]!.replace("src-", "");
    expect(stored[`only-${n}`]).toBe("x");
  });

  it("campos diferentes em paralelo são todos complementados, sem perda", async () => {
    const fields = ["fbclid", "gclid", "ttclid", "utmifyId", "redtrackClickId"] as const;
    await post({ sessionId: "s-merge", pageUrl: "https://a.com" });
    await Promise.all(
      fields.map((f) => post({ sessionId: "s-merge", pageUrl: "https://a.com", identifiers: { [f]: `${f}-v` } })),
    );
    const row = await load("s-merge");
    for (const f of fields) expect(row[f]).toBe(`${f}-v`);
  });
});
