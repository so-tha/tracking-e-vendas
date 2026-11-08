import { hashOrNull, normalizeEmailBasic, normalizePhoneMeta } from "../../../shared/pii.js";
import { decimalToNumber, executeSend, unixSeconds } from "../http.js";
import {
  identifierValue,
  isOlderThanSevenDays,
  type ConversionEvent,
  type ConversionProvider,
  type Eligibility,
  type HttpRequest,
  type HttpTransport,
} from "../types.js";

export interface MetaConfig {
  pixelId: string;
  accessToken: string;
  apiVersion: string;
}

/**
 * Meta Conversions API (ADR-037).
 * Confirmado: endpoint, corpo `data[]`, campos obrigatórios, janela de 7 dias, hash de em/ph, fbc/fbp sem hash.
 * Desvio declarado: `client_user_agent` é exigido para eventos web e não é capturado neste projeto.
 */
export function createMetaProvider(config: MetaConfig, transport: HttpTransport): ConversionProvider {
  return {
    name: "META",

    eligibility(event: ConversionEvent, now: Date): Eligibility {
      if (isOlderThanSevenDays(event, now)) return { eligible: false, reason: "EVENT_TOO_OLD" };
      if (!identifierValue(event, "fbc") && !identifierValue(event, "fbp")) {
        return { eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:fbc|fbp" };
      }
      if (!event.pageUrl) return { eligible: false, reason: "MISSING_REQUIRED_FIELD:event_source_url" };
      return { eligible: true };
    },

    buildRequest(event: ConversionEvent): HttpRequest {
      const userData: Record<string, unknown> = {};

      const email = event.customer.email ? normalizeEmailBasic(event.customer.email) : null;
      const phone = event.customer.phone ? normalizePhoneMeta(event.customer.phone) : null;
      const emailHash = hashOrNull(email);
      const phoneHash = hashOrNull(phone);
      if (emailHash) userData["em"] = [emailHash];
      if (phoneHash) userData["ph"] = [phoneHash];

      // fbc e fbp nunca levam hash (oficial).
      const fbc = identifierValue(event, "fbc");
      const fbp = identifierValue(event, "fbp");
      if (fbc) userData["fbc"] = fbc;
      if (fbp) userData["fbp"] = fbp;

      const customData: Record<string, unknown> = {
        currency: event.currency,
        value: decimalToNumber(event.amountDecimal),
      };
      // Único contrato com um contêiner genérico de dados do evento. Já restrito aos níveis 1 a 3.
      if (event.affiliateCode) customData["affiliate_code"] = event.affiliateCode;

      return {
        method: "POST",
        url: `https://graph.facebook.com/${config.apiVersion}/${config.pixelId}/events`,
        headers: { "Content-Type": "application/json" },
        secretQuery: { access_token: config.accessToken },
        body: {
          data: [
            {
              event_name: event.eventName,
              event_time: unixSeconds(event.occurredAt),
              event_id: event.eventId,
              event_source_url: event.pageUrl,
              action_source: "website",
              user_data: userData,
              custom_data: customData,
            },
          ],
        },
      };
    },

    send(event: ConversionEvent) {
      return executeSend(this.buildRequest(event), transport);
    },
  };
}
