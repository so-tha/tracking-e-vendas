import { describe, expect, it } from "vitest";
import { createRedTrackProvider } from "../../src/modules/conversions/providers/redtrack.js";
import { createRedTrackSimulator } from "../../src/modules/conversions/simulators/redtrack.js";
import { TransportError, type HttpRequest } from "../../src/modules/conversions/types.js";
import { NOW, onlyIdentifiers, sampleEvent } from "./helpers/events.js";

const config = { trackingDomain: "track.exemplo.com", conversionType: "Purchase" };
const setup = () => {
  const sim = createRedTrackSimulator({ trackingDomain: config.trackingDomain });
  return { sim, provider: createRedTrackProvider(config, sim.transport) };
};
const queryOf = (request: HttpRequest) => new URL(request.url).searchParams;

describe("RedTrack: contrato do postback", () => {
  const { provider } = setup();

  it("monta o postback GET no domínio de tracking, com clickid, valor, tipo e rdtk_event_id", () => {
    const request = provider.buildRequest(sampleEvent());
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(request.url).toBe("https://track.exemplo.com/postback?clickid=redtrack-click-id&sum=255.00&type=Purchase&rdtk_event_id=ORD-001");
  });

  it("o valor segue como texto decimal exato, sem ponto flutuante", () => {
    expect(queryOf(provider.buildRequest(sampleEvent({ amountDecimal: "0.30" }))).get("sum")).toBe("0.30");
    expect(queryOf(provider.buildRequest(sampleEvent({ amountDecimal: "90071992547409.93" }))).get("sum")).toBe("90071992547409.93");
    expect(queryOf(provider.buildRequest(sampleEvent({ currency: "JPY", amountDecimal: "500" }))).get("sum")).toBe("500");
  });

  it("o tipo de conversão é usado exatamente como configurado (diferencia maiúsculas)", () => {
    const custom = createRedTrackProvider({ ...config, conversionType: "Upsell Purchase" }, setup().sim.transport);
    expect(queryOf(custom.buildRequest(sampleEvent())).get("type")).toBe("Upsell Purchase");
    expect(custom.buildRequest(sampleEvent()).url).toContain("type=Upsell+Purchase");
  });

  it("a chave de deduplicação é o orderId", () => {
    expect(queryOf(provider.buildRequest(sampleEvent())).get("rdtk_event_id")).toBe("ORD-001");
  });

  it("codifica caracteres especiais do clickid", () => {
    const request = provider.buildRequest(sampleEvent({ identifiers: { redtrackClickId: { value: "a b&c=d", source: "SESSION" } } }));
    expect(queryOf(request).get("clickid")).toBe("a b&c=d");
    expect(request.url).not.toContain("a b&c=d");
  });

  it("não envia dados pessoais, afiliado nem credenciais", () => {
    const request = provider.buildRequest(sampleEvent());
    const everything = JSON.stringify(request);
    expect(everything).not.toContain("cliente");
    expect(everything).not.toContain("5511999999999");
    expect(everything).not.toContain("AFF-001");
    expect(request.headers).toEqual({});
    expect(request.secretQuery).toBeUndefined();
  });

  it("usa só o identificador do RedTrack, e não os de outras redes", () => {
    expect(queryOf(provider.buildRequest(sampleEvent())).get("clickid")).toBe("redtrack-click-id");
  });
});

describe("RedTrack: elegibilidade (ADR-016, ADR-037)", () => {
  const { provider } = setup();

  it("elegível com redtrackClickId", () => expect(provider.eligibility(sampleEvent(), NOW)).toEqual({ eligible: true }));
  it("SKIPPED sem redtrackClickId, mesmo com os demais identificadores e dados pessoais", () => {
    expect(provider.eligibility(onlyIdentifiers(sampleEvent(), "fbc", "gclid", "ttclid", "utmifyId"), NOW)).toEqual({
      eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:redtrackClickId",
    });
  });
  it("não aplica limite de idade nem exige pageUrl ou e-mail", () => {
    const event = sampleEvent({ occurredAt: "2020-01-01T00:00:00.000Z", pageUrl: null, customer: { email: null, phone: null } });
    expect(provider.eligibility(event, NOW)).toEqual({ eligible: true });
  });
});

describe("RedTrack: envio contra o simulador do contrato", () => {
  it("aceita o postback gerado e audita a URL completa", async () => {
    const { sim, provider } = setup();
    const result = await provider.send(sampleEvent());
    expect(result).toMatchObject({ outcome: "SUCCESS", httpStatus: 200, error: null });
    expect(result.request).toEqual({
      method: "GET",
      url: "https://track.exemplo.com/postback?clickid=redtrack-click-id&sum=255.00&type=Purchase&rdtk_event_id=ORD-001",
    });
    expect(sim.recorded).toEqual([{ clickid: "redtrack-click-id", sum: "255.00", type: "Purchase", eventId: "ORD-001" }]);
  });

  it("a deduplicação por rdtk_event_id absorve o reenvio: duas chamadas, uma conversão", async () => {
    const { sim, provider } = setup();
    await provider.send(sampleEvent());
    const second = await provider.send(sampleEvent());
    expect(second.outcome).toBe("SUCCESS");
    expect(sim.requests).toHaveLength(2);
    expect(sim.recorded).toHaveLength(1);
  });

  it("pedidos diferentes geram conversões diferentes", async () => {
    const { sim, provider } = setup();
    await provider.send(sampleEvent());
    await provider.send(sampleEvent({ orderId: "ORD-002", eventId: "ORD-002" }));
    expect(sim.recorded).toHaveLength(2);
  });

  it("o simulador recusa violações do contrato", async () => {
    const { sim, provider } = setup();
    const status = async (mutate: (url: URL) => void) => {
      const request = provider.buildRequest(sampleEvent());
      const url = new URL(request.url);
      mutate(url);
      return (await sim.transport.request({ ...request, url: url.toString() })).status;
    };
    expect(await status((u) => u.searchParams.delete("clickid"))).toBe(400);
    expect(await status((u) => u.searchParams.delete("sum"))).toBe(400);
    expect(await status((u) => u.searchParams.set("sum", "abc"))).toBe(400);
    expect(await status((u) => u.searchParams.delete("type"))).toBe(400);
    expect(await status((u) => { u.host = "painel.redtrack.io"; })).toBe(404);
    expect(sim.recorded).toHaveLength(0);
  });

  it("aceita 204 como sucesso", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 204, body: null });
    expect((await provider.send(sampleEvent())).outcome).toBe("SUCCESS");
  });
});

describe("RedTrack: classificação de resultados", () => {
  it("503 e 429 (com Retry-After) são transitórios", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { status: 503 });
    expect((await provider.send(sampleEvent())).outcome).toBe("TRANSIENT");
    sim.failNext(1, { status: 429, headers: { "Retry-After": "7" } });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", retryAfterMs: 7000 });
  });
  it("400 e 404 são permanentes", async () => {
    const { sim, provider } = setup();
    for (const status of [400, 404]) {
      sim.failNext(1, { status });
      expect((await provider.send(sampleEvent())).outcome).toBe("PERMANENT");
    }
  });
  it("falha de rede é transitória e não lança", async () => {
    const { sim, provider } = setup();
    sim.failNext(1, { throws: new TransportError("timeout", "sem resposta") });
    expect(await provider.send(sampleEvent())).toMatchObject({ outcome: "TRANSIENT", httpStatus: null });
  });
});
