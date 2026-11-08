import { normalizeEmailBasic, normalizePhoneMeta } from "../../../shared/pii.js";
import { executeSend, utcDateTime } from "../http.js";
import {
  ContractError,
  identifierValue,
  isOlderThanSevenDays,
  type ConversionEvent,
  type ConversionProvider,
  type Eligibility,
  type HttpRequest,
  type HttpTransport,
} from "../types.js";

export interface UtmifyConfig {
  apiToken: string;
  /** Nome da plataforma de vendas (campo obrigatório do contrato). */
  platform: string;
  /** O webhook não informa o método de pagamento. */
  paymentMethod: "credit_card" | "boleto" | "pix" | "paypal" | "free_price";
  /** O webhook não informa o nome do cliente. */
  customerName: string;
}

/** Chaves de customFields que alimentam os parâmetros utm da UTMify (nomes escolhidos por nós). */
const UTM_FROM_CUSTOM_FIELDS = {
  utm_source: "source",
  utm_campaign: "campaign",
  utm_content: "content",
  utm_medium: "medium",
  utm_term: "term",
} as const;

const textOrNull = (customFields: Record<string, unknown> | null, key: string): string | null => {
  const value = customFields?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const hasCampaignData = (event: ConversionEvent): boolean =>
  Object.values(UTM_FROM_CUSTOM_FIELDS).some((key) => textOrNull(event.customFields, key) !== null);

function safeInteger(amountMinor: string): number {
  const value = Number(amountMinor);
  if (!Number.isSafeInteger(value)) throw new ContractError("VALUE_NOT_REPRESENTABLE");
  return value;
}

/**
 * UTMify, envio de vendas.
 * O webhook de pedidos não traz nome, método de pagamento, produtos nem taxas, então esses campos
 * usam os valores padrão declarados no ADR-037. O contrato pede e-mail e telefone em texto claro.
 * O `affiliateCode` não é enviado: o contrato não tem campo para ele.
 */
export function createUtmifyProvider(config: UtmifyConfig, transport: HttpTransport): ConversionProvider {
  return {
    name: "UTMIFY",

    eligibility(event: ConversionEvent, now: Date): Eligibility {
      // Pedidos com mais de 7 dias não são aceitos (oficial).
      if (isOlderThanSevenDays(event, now)) return { eligible: false, reason: "EVENT_TOO_OLD" };
      if (!event.customer.email || !normalizeEmailBasic(event.customer.email)) {
        return { eligible: false, reason: "MISSING_REQUIRED_FIELD:customer.email" };
      }
      if (!identifierValue(event, "utmifyId") && !hasCampaignData(event)) {
        return { eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:utmifyId|customFields" };
      }
      return { eligible: true };
    },

    buildRequest(event: ConversionEvent): HttpRequest {
      const email = event.customer.email ? normalizeEmailBasic(event.customer.email) : null;
      if (!email) throw new ContractError("MISSING_REQUIRED_FIELD:customer.email");

      const amount = safeInteger(event.amountMinor);
      const phone = event.customer.phone ? normalizePhoneMeta(event.customer.phone) : null;

      const trackingParameters: Record<string, string | null> = {
        src: null,
        // A documentação lista `sck` sem defini-lo. Mapeamos o utmifyId (suposição, ADR-037).
        sck: identifierValue(event, "utmifyId"),
      };
      for (const [parameter, key] of Object.entries(UTM_FROM_CUSTOM_FIELDS)) {
        trackingParameters[parameter] = textOrNull(event.customFields, key);
      }

      const commission: Record<string, unknown> = {
        totalPriceInCents: amount,
        gatewayFeeInCents: 0,
        userCommissionInCents: amount,
      };
      // A documentação manda omitir a moeda para BRL.
      if (event.currency !== "BRL") commission["currency"] = event.currency;

      const paidAt = utcDateTime(event.occurredAt);
      return {
        method: "POST",
        url: "https://api.utmify.com.br/api-credentials/orders",
        headers: { "Content-Type": "application/json", "x-api-token": config.apiToken },
        body: {
          orderId: event.orderId,
          platform: config.platform,
          paymentMethod: config.paymentMethod,
          status: "paid",
          createdAt: paidAt,
          approvedDate: paidAt,
          refundedAt: null,
          customer: { name: config.customerName, email, phone, document: null },
          products: [
            { id: event.orderId, name: `Pedido ${event.orderId}`, planId: null, planName: null, quantity: 1, priceInCents: amount },
          ],
          trackingParameters,
          commission,
        },
      };
    },

    send(event: ConversionEvent) {
      return executeSend(this.buildRequest(event), transport);
    },
  };
}
