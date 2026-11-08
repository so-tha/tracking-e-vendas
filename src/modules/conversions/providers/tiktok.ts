import { hashOrNull, normalizeEmailBasic, normalizePhoneE164 } from "../../../shared/pii.js";
import { decimalToNumber, executeSend, unixSeconds } from "../http.js";
import {
  identifierValue,
  type ConversionEvent,
  type ConversionProvider,
  type Eligibility,
  type HttpRequest,
  type HttpTransport,
} from "../types.js";

/** Código de limite de requisições (documentação oficial "Rate limits Overview" da API for Business). */
const RATE_LIMIT_CODE = 40100;
/** Espera oficial depois de estourar o limite por minuto (QPM). */
const RATE_LIMIT_WAIT_MS = 5 * 60_000;

export interface TikTokConfig {
  /** Código do pixel (event_source_id quando event_source é web). */
  pixelCode: string;
  accessToken: string;
}

/**
 * TikTok Events API 2.0.
 * Só a deduplicação (event + event_id, 48h). O endpoint e os campos vêm de
 * fontes secundárias (parceiros) e estão marcados como suposição.
 */
export function createTikTokProvider(config: TikTokConfig, transport: HttpTransport): ConversionProvider {
  return {
    name: "TIKTOK",

    eligibility(event: ConversionEvent): Eligibility {
      if (!identifierValue(event, "ttclid") && !identifierValue(event, "ttp")) {
        return { eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:ttclid|ttp" };
      }
      return { eligible: true };
    },

    buildRequest(event: ConversionEvent): HttpRequest {
      const user: Record<string, string> = {};

      // ttclid e ttp seguem sem hash. Com hash, o evento fica sem correspondência.
      const ttclid = identifierValue(event, "ttclid");
      const ttp = identifierValue(event, "ttp");
      if (ttclid) user["ttclid"] = ttclid;
      if (ttp) user["ttp"] = ttp;

      const emailHash = hashOrNull(event.customer.email ? normalizeEmailBasic(event.customer.email) : null);
      const phoneHash = hashOrNull(event.customer.phone ? normalizePhoneE164(event.customer.phone) : null);
      if (emailHash) user["email"] = emailHash;
      if (phoneHash) user["phone"] = phoneHash;

      return {
        method: "POST",
        url: "https://business-api.tiktok.com/open_api/v1.3/event/track/",
        headers: { "Content-Type": "application/json", "Access-Token": config.accessToken },
        body: {
          event_source: "web",
          event_source_id: config.pixelCode,
          data: [
            {
              event: event.eventName,
              event_time: unixSeconds(event.occurredAt),
              event_id: event.eventId,
              user,
              properties: { currency: event.currency, value: decimalToNumber(event.amountDecimal) },
            },
          ],
        },
      };
    },

    send(event: ConversionEvent) {
      // A API do TikTok devolve erros no corpo (`code` diferente de 0), inclusive com HTTP 200.
      return executeSend(this.buildRequest(event), transport, (response, base) => {
        const body = response.body;
        if (base.outcome === "SUCCESS" && typeof body === "object" && body !== null && "code" in body) {
          const code = (body as { code: unknown }).code;
          // Oficial: 40100 é limite de requisições, e é preciso esperar 5 minutos.
          if (code === RATE_LIMIT_CODE) {
            return { outcome: "TRANSIENT", error: `TikTok code ${code} (limite de requisições)`, retryAfterMs: RATE_LIMIT_WAIT_MS };
          }
          // Suposição: os demais códigos diferentes de 0 são permanentes.
          if (code !== 0) return { outcome: "PERMANENT", error: `TikTok code ${String(code)}`, retryAfterMs: null };
        }
        return base;
      });
    },
  };
}
