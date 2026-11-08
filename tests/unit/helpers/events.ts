import { buildConversionEvent } from "../../../src/modules/conversions/event.js";
import type { ConversionEvent } from "../../../src/modules/conversions/types.js";

export const NOW = new Date("2026-01-10T12:00:30.000Z");

/** Evento completo, atribuído pelo nível 1, com todos os identificadores em formatos realistas. */
export function sampleEvent(overrides: Partial<ConversionEvent> = {}): ConversionEvent {
  const event = buildConversionEvent({
    order: { orderId: "ORD-001", amountMinor: 25500n, currency: "USD", customerEmail: "cliente@email.com", receivedAt: new Date("2026-01-10T12:00:00.000Z") },
    attribution: {
      result: "ATTRIBUTED",
      level: 1,
      sessionId: "session_123",
      identifiers: {
        fbclid: { value: "fb-click-id", source: "SESSION" },
        fbc: { value: "fb.1.1767268000000.AbCdEf", source: "SESSION" },
        fbp: { value: "fb.1.1767267000000.1234567890", source: "SESSION" },
        gclid: { value: "google-click-id", source: "SESSION" },
        ttclid: { value: "tiktok-click-id", source: "SESSION" },
        ttp: { value: "tiktok-cookie", source: "SESSION" },
        redtrackClickId: { value: "redtrack-click-id", source: "SESSION" },
        utmifyId: { value: "utmify-id", source: "SESSION" },
      },
      customFields: { source: "facebook", campaign: "black-friday", content: "criativo-01", affiliateCode: "AFF-001" },
      affiliate: { code: "AFF-001", source: "WEBHOOK", evidenceLevel: 1 },
      alerts: [],
    },
    session: { pageUrl: "https://checkout.exemplo.com/produto", customerEmail: null, customerPhone: "+5511999999999" },
  });
  return { ...event, ...overrides };
}

/** Evento sem nenhum identificador (para testar elegibilidade). */
export const withoutIdentifiers = (event: ConversionEvent, ...fields: string[]): ConversionEvent => {
  const identifiers = { ...event.identifiers } as Record<string, unknown>;
  for (const field of fields) delete identifiers[field];
  return { ...event, identifiers: identifiers as ConversionEvent["identifiers"] };
};

export const onlyIdentifiers = (event: ConversionEvent, ...fields: string[]): ConversionEvent => {
  const source = event.identifiers as Record<string, unknown>;
  const identifiers: Record<string, unknown> = {};
  for (const field of fields) if (source[field]) identifiers[field] = source[field];
  return { ...event, identifiers: identifiers as ConversionEvent["identifiers"] };
};
