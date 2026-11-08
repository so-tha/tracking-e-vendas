import { isSha256Hex } from "../../../shared/pii.js";
import { SEVEN_DAYS_MS } from "../types.js";
import { createSimulator, isRecord, json, type Simulator } from "./base.js";

const ACTION_SOURCES = ["email", "website", "app", "phone_call", "chat", "physical_store", "system_generated", "business_messaging", "other"];
const MAX_EVENTS = 1000;

const error = (message: string, code = 100) =>
  json(400, { error: { message, type: "OAuthException", code, fbtrace_id: "SIMULATED" } });

/**
 * Simulador da Meta Conversions API. Valida o que a documentação oficial confirma.
 * O formato de fbc/fbp NÃO é validado: o documento original usa exemplos fora do formato oficial,
 * e a validação fica a cargo do provedor real.
 */
export function createMetaSimulator(options: { now?: () => Date } = {}): Simulator {
  const now = options.now ?? (() => new Date());

  return createSimulator((request) => {
    const url = new URL(request.fullUrl);
    if (url.host !== "graph.facebook.com" || !/^\/v\d+\.\d+\/[^/]+\/events$/.test(url.pathname)) {
      return json(404, { error: { message: "Unsupported post request", type: "GraphMethodException", code: 100 } });
    }
    if (request.method !== "POST") return error("Unsupported request method");
    if (!url.searchParams.get("access_token")) return error("Invalid OAuth access token", 190);

    const body = request.body;
    if (!isRecord(body) || !Array.isArray(body["data"]) || body["data"].length < 1) return error("data must be a non-empty array");
    if (body["data"].length > MAX_EVENTS) return error(`At most ${MAX_EVENTS} events per request`);

    for (const event of body["data"]) {
      if (!isRecord(event)) return error("each event must be an object");
      if (typeof event["event_name"] !== "string" || event["event_name"] === "") return error("event_name is required");
      if (!Number.isInteger(event["event_time"])) return error("event_time must be a Unix timestamp in seconds");
      // Oficial: um event_time com mais de 7 dias derruba a requisição inteira.
      if (now().getTime() - (event["event_time"] as number) * 1000 > SEVEN_DAYS_MS) {
        return error("event_time is more than 7 days in the past");
      }
      if (!ACTION_SOURCES.includes(event["action_source"] as string)) return error("action_source is required and must be a valid value");
      if (event["action_source"] === "website" && typeof event["event_source_url"] !== "string") {
        return error("event_source_url is required for website events");
      }

      const userData = event["user_data"];
      if (!isRecord(userData) || Object.keys(userData).length === 0) return error("user_data is required");
      for (const key of ["em", "ph"] as const) {
        if (userData[key] === undefined) continue;
        const values = Array.isArray(userData[key]) ? (userData[key] as unknown[]) : [userData[key]];
        if (!values.every(isSha256Hex)) return error(`${key} must be SHA-256 hashed`);
      }
      for (const key of ["fbc", "fbp"] as const) {
        if (userData[key] !== undefined && isSha256Hex(userData[key])) return error(`${key} must not be hashed`);
      }

      if (event["event_name"] === "Purchase") {
        const customData = event["custom_data"];
        if (!isRecord(customData) || typeof customData["value"] !== "number" || typeof customData["currency"] !== "string") {
          return error("Purchase requires custom_data.value and custom_data.currency");
        }
      }
    }

    return json(200, { events_received: body["data"].length, messages: [], fbtrace_id: "SIMULATED" });
  });
}
