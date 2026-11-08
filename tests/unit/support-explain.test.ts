import { describe, expect, it } from "vitest";
import {
  explainAlert,
  explainAttribution,
  explainConversion,
  explainEventStatus,
  explainFailure,
  explainSkip,
  explainUnattributed,
} from "../../src/modules/support/explain.js";

describe("explicações do porquê", () => {
  it.each([
    "NO_EVIDENCE",
    "NO_MATCHING_SESSION",
    "AMBIGUOUS_PLATFORM_IDENTIFIER",
    "AMBIGUOUS_CLICK_ID",
    "AMBIGUOUS_CUSTOMER_WINDOW",
  ])("explica o motivo de não atribuição %s", (reason) => {
    const text = explainUnattributed(reason)!;
    expect(text.length).toBeGreaterThan(40);
    expect(text).not.toContain("desconhecido");
    expect(text).not.toContain(reason);
  });

  it.each(["AMBIGUOUS_PLATFORM_IDENTIFIER", "AMBIGUOUS_CLICK_ID", "AMBIGUOUS_CUSTOMER_WINDOW"])(
    "a ambiguidade %s explica que nenhuma sessão foi escolhida",
    (reason) => {
      expect(explainUnattributed(reason)).toContain("Nenhuma foi escolhida");
    },
  );

  it("motivo desconhecido não quebra e mostra o código", () => {
    expect(explainUnattributed("OUTRO")).toContain("OUTRO");
    expect(explainUnattributed(null)).toBeNull();
  });

  it("explica o método de atribuição", () => {
    expect(explainAttribution(1, "SESSION_ID")).toContain("nível 1");
    expect(explainAttribution(4, "CUSTOMER_WINDOW")).toContain("nível 4");
  });

  it("explica SKIPPED com os identificadores faltantes em português", () => {
    expect(explainSkip("MISSING_REQUIRED_IDENTIFIER:fbc|fbp")).toContain("(fbc ou fbp)");
    expect(explainSkip("MISSING_REQUIRED_IDENTIFIER:gclid|gbraid|wbraid")).toContain("(gclid, gbraid ou wbraid)");
    expect(explainSkip("MISSING_REQUIRED_IDENTIFIER:redtrackClickId")).toContain("(redtrackClickId)");
    expect(explainSkip("MISSING_REQUIRED_FIELD:customer.email")).toContain("customer.email");
    expect(explainSkip("EVENT_TOO_OLD")).toContain("7 dias");
    expect(explainSkip(null)).toBeNull();
  });

  it("explica falhas permanentes", () => {
    expect(explainFailure("RETRIES_EXHAUSTED")).toContain("transitórios");
    expect(explainFailure("PROVIDER_REJECTED:400")).toContain("HTTP 400");
    expect(explainFailure("PROVIDER_REJECTED:400")).toContain("permanente");
    expect(explainFailure("CONTRACT_ERROR:VALUE_NOT_REPRESENTABLE")).toContain("VALUE_NOT_REPRESENTABLE");
    expect(explainFailure("EVENT_TOO_OLD")).toContain("7 dias");
  });

  it("explica o estado de cada conversão", () => {
    const base = { provider: "META", skipReason: null, failureReason: null, attemptCount: 0, nextAttemptAt: null };
    expect(explainConversion({ ...base, status: "DELIVERED", attemptCount: 2 })).toBe("Entregue ao provedor na tentativa 2.");
    expect(explainConversion({ ...base, status: "PENDING" })).toContain("primeira entrega");
    expect(explainConversion({ ...base, status: "PENDING", attemptCount: 1, nextAttemptAt: new Date("2026-01-01T00:00:00Z") })).toContain("2026-01-01T00:00:00.000Z");
    expect(explainConversion({ ...base, status: "SKIPPED", skipReason: "EVENT_TOO_OLD" })).toContain("7 dias");
    expect(explainConversion({ ...base, status: "FAILED_PERMANENT", failureReason: "RETRIES_EXHAUSTED" })).toContain("transitórios");
  });

  it("explica os alertas de atribuição sem expor dados pessoais", () => {
    const alert = explainAlert({
      code: "ATTRIBUTION_CONFLICT",
      details: [
        { kind: "OTHER_SESSION_EVIDENCE", level: 3, method: "CLICK_ID", sessionIds: ["B"] },
        { kind: "IDENTIFIER_MISMATCH", field: "fbclid" },
        { kind: "EMAIL_MISMATCH" },
      ],
    });
    expect(alert.explanation).toContain("nível 3");
    expect(alert.explanation).toContain("fbclid");
    expect(alert.explanation).toContain("e-mail");
    expect(explainAlert({ code: "CUSTOM_FIELDS_DIVERGENCE", details: { used: "WEBHOOK" } }).explanation).toContain("sem mesclar");
  });

  it("explica o estado dos eventos", () => {
    for (const status of ["RECEIVED", "PROCESSED", "IGNORED_UNSUPPORTED", "DUPLICATE_ORDER", "FAILED"]) {
      expect(explainEventStatus(status)).not.toBe(status);
    }
  });
});
