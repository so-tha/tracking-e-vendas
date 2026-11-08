import { executeSend } from "../http.js";
import {
  identifierValue,
  type ConversionEvent,
  type ConversionProvider,
  type Eligibility,
  type HttpRequest,
  type HttpTransport,
} from "../types.js";

export interface RedTrackConfig {
  /** Domínio de tracking/postback (não o do painel). */
  trackingDomain: string;
  /** Nome do tipo de conversão. Diferencia maiúsculas e precisa existir exatamente igual no RedTrack. */
  conversionType: string;
}

/**
 * RedTrack, postback server-to-server.
 * Confirmado: `clickid` e valor são obrigatórios, tipos diferenciam maiúsculas, deduplicação por
 * `rdtk_event_id`. O formato da URL vem de guias de parceiros. Nenhum dado pessoal é enviado e não há
 * campo documentado para o afiliado, então ele não é enviado.
 */
export function createRedTrackProvider(config: RedTrackConfig, transport: HttpTransport): ConversionProvider {
  return {
    name: "REDTRACK",

    eligibility(event: ConversionEvent): Eligibility {
      if (!identifierValue(event, "redtrackClickId")) {
        return { eligible: false, reason: "MISSING_REQUIRED_IDENTIFIER:redtrackClickId" };
      }
      return { eligible: true };
    },

    buildRequest(event: ConversionEvent): HttpRequest {
      const clickId = identifierValue(event, "redtrackClickId");
      if (!clickId) throw new Error("redtrackClickId ausente: a elegibilidade deveria ter impedido o envio");

      // Ordem fixa dos parâmetros: a URL gravada na auditoria é determinística.
      const query = new URLSearchParams();
      query.set("clickid", clickId);
      // O valor segue como texto decimal ("255.00"), sem passar por número de ponto flutuante.
      query.set("sum", event.amountDecimal);
      query.set("type", config.conversionType);
      // Deduplicação oficial: exige o modo "ignorar postbacks duplicados por event id" na conta.
      query.set("rdtk_event_id", event.eventId);

      return {
        method: "GET",
        url: `https://${config.trackingDomain}/postback?${query.toString()}`,
        headers: {},
      };
    },

    send(event: ConversionEvent) {
      return executeSend(this.buildRequest(event), transport);
    },
  };
}
