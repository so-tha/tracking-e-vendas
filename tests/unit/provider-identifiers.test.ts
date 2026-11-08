import { describe, expect, it } from "vitest";
import { PROVIDER_IDENTIFIER_FIELDS } from "../../src/modules/conversions/identifiers.js";
import { createSimulatedEnvironment } from "../../src/modules/conversions/providers/index.js";
import { testProvidersConfig } from "../integration/helpers/orders.js";
import { IDENTIFIER_FIELDS } from "../../src/modules/tracking/normalize.js";
import type { ConversionEvent, ProviderName } from "../../src/modules/conversions/types.js";
import { NOW, sampleEvent } from "./helpers/events.js";

const { registry } = createSimulatedEnvironment(testProvidersConfig);

/** Evento que cumpre todos os outros requisitos e tem só o identificador pedido. */
const onlyField = (field: string): ConversionEvent => ({
  ...sampleEvent({ customFields: null }),
  identifiers: { [field]: { value: "valor", source: "SESSION" } },
});

describe("PROVIDER_IDENTIFIER_FIELDS é consistente com a elegibilidade real de cada adaptador", () => {
  for (const provider of Object.keys(PROVIDER_IDENTIFIER_FIELDS) as ProviderName[]) {
    it(`${provider}: elegível com cada identificador da lista, e não elegível com os de fora`, () => {
      const inside = PROVIDER_IDENTIFIER_FIELDS[provider];
      for (const field of inside) {
        expect(registry[provider].eligibility(onlyField(field), NOW), `${provider} com ${field}`).toEqual({ eligible: true });
      }
      for (const field of IDENTIFIER_FIELDS.filter((f) => !(inside as readonly string[]).includes(f))) {
        expect(registry[provider].eligibility(onlyField(field), NOW).eligible, `${provider} com ${field}`).toBe(false);
      }
    });
  }
});
