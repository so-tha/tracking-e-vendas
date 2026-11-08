import { isSha256Hex } from "../../../shared/pii.js";
import { createSimulator, isRecord, json, type Simulator } from "./base.js";

const MAX_EVENTS = 50;

const invalid = (message: string) => json(400, { code: 40002, message, request_id: "SIMULATED" });

/**
 * Simulador da Events API do TikTok. Os campos vêm de fontes secundárias (ADR-037, suposição),
 * mas o simulador os valida de forma estrita para provar que o adaptador respeita o contrato adotado.
 */
export function createTikTokSimulator(): Simulator {
  return createSimulator((request) => {
    const url = new URL(request.fullUrl);
    if (url.host !== "business-api.tiktok.com" || url.pathname !== "/open_api/v1.3/event/track/") {
      return json(404, { code: 40001, message: "Not Found" });
    }
    if (request.method !== "POST") return json(405, { code: 40001, message: "Method Not Allowed" });
    if (!request.headers["Access-Token"]) return json(401, { code: 40105, message: "Access-Token is missing" });

    const body = request.body;
    if (!isRecord(body)) return invalid("body must be an object");
    if (body["event_source"] !== "web") return invalid("event_source must be web");
    if (typeof body["event_source_id"] !== "string" || body["event_source_id"] === "") return invalid("event_source_id (pixel code) is required");

    const data = body["data"];
    if (!Array.isArray(data) || data.length < 1) return invalid("data is required");
    if (data.length > MAX_EVENTS) return invalid(`At most ${MAX_EVENTS} events per request`);

    for (const event of data) {
      if (!isRecord(event)) return invalid("each event must be an object");
      if (typeof event["event"] !== "string" || event["event"] === "") return invalid("event is required");
      if (!Number.isInteger(event["event_time"])) return invalid("event_time must be a Unix timestamp in seconds");
      if (typeof event["event_id"] !== "string" || event["event_id"] === "") return invalid("event_id is required");

      const user = event["user"];
      if (!isRecord(user) || Object.keys(user).length === 0) return invalid("user is required");
      for (const key of ["ttclid", "ttp"] as const) {
        if (user[key] !== undefined && isSha256Hex(user[key])) return invalid(`${key} must not be hashed`);
      }
      for (const key of ["email", "phone"] as const) {
        if (user[key] !== undefined && !isSha256Hex(user[key])) return invalid(`${key} must be SHA-256 hashed`);
      }

      if (event["event"] === "Purchase") {
        const properties = event["properties"];
        if (!isRecord(properties) || typeof properties["value"] !== "number" || typeof properties["currency"] !== "string") {
          return invalid("Purchase requires properties.value and properties.currency");
        }
      }
    }

    return json(200, { code: 0, message: "OK", request_id: "SIMULATED", data: {} });
  });
}
