import { hashOrNull, normalizeEmailGoogle, normalizePhoneE164 } from "../../../shared/pii.js";
import { decimalToNumber, executeSend } from "../http.js";
import {
  identifierValue,
  type ConversionEvent,
  type ConversionProvider,
  type Eligibility,
  type HttpRequest,
  type HttpTransport,
} from "../types.js";

export interface GoogleConfig {
  /** ID da conta do Google Ads (operatingAccount). */
  accountId: string;
  /** ID da ação de conversão, que precisa ser do tipo WEBPAGE (productDestinationId). */
  conversionActionId: string;
  accessToken: string;
}

const AD_IDENTIFIERS = ["gclid", "gbraid", "wbraid"] as const;

/**
 * Google Data Manager API, `events:ingest`. A API de conversões por clique do Google Ads
 * falha desde 15/06/2026 sem autorização prévia, e a documentação recomenda a Data Manager API.
 * O `consent` é omitido de propósito: não temos o consentimento do usuário e não vamos inventá-lo.
 */
export function createGoogleProvider(config: GoogleConfig, transport: HttpTransport): ConversionProvider {
  return {
    name: "GOOGLE",

    eligibility(event: ConversionEvent): Eligibility {
      if (!AD_IDENTIFIERS.some((field) => identifierValue(event, field))) {
        return { eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:gclid|gbraid|wbraid" };
      }
      return { eligible: true };
    },

    buildRequest(event: ConversionEvent): HttpRequest {
      // Oficial: defina todos os identificadores de clique capturados. O Google escolhe um.
      const adIdentifiers: Record<string, string> = {};
      for (const field of AD_IDENTIFIERS) {
        const value = identifierValue(event, field);
        if (value) adIdentifiers[field] = value;
      }

      // Cada UserIdentifier carrega UM só dado (oficial), por isso um objeto para cada.
      const userIdentifiers: Record<string, string>[] = [];
      const emailHash = hashOrNull(event.customer.email ? normalizeEmailGoogle(event.customer.email) : null);
      const phoneHash = hashOrNull(event.customer.phone ? normalizePhoneE164(event.customer.phone) : null);
      if (emailHash) userIdentifiers.push({ emailAddress: emailHash });
      if (phoneHash) userIdentifiers.push({ phoneNumber: phoneHash });

      const googleEvent: Record<string, unknown> = {
        eventTimestamp: event.occurredAt,
        transactionId: event.eventId,
        eventSource: "WEB",
        conversionValue: decimalToNumber(event.amountDecimal),
        currency: event.currency,
        adIdentifiers,
      };
      if (userIdentifiers.length > 0) googleEvent["userData"] = { userIdentifiers };

      const body: Record<string, unknown> = {
        destinations: [
          {
            operatingAccount: { accountType: "GOOGLE_ADS", accountId: config.accountId },
            productDestinationId: config.conversionActionId,
          },
        ],
        events: [googleEvent],
      };
      // `encoding` é exigido apenas quando há dados do usuário (oficial) e precisa casar com o usado.
      if (userIdentifiers.length > 0) body["encoding"] = "HEX";

      return {
        method: "POST",
        url: "https://datamanager.googleapis.com/v1/events:ingest",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.accessToken}` },
        body,
      };
    },

    send(event: ConversionEvent) {
      return executeSend(this.buildRequest(event), transport);
    },
  };
}
