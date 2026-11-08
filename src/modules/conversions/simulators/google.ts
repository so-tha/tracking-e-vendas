import { isSha256Hex } from "../../../shared/pii.js";
import { createSimulator, isRecord, json, type Simulator } from "./base.js";

const MAX_EVENTS = 2000;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const invalid = (message: string) => json(400, { error: { code: 400, message, status: "INVALID_ARGUMENT" } });

/** Simulador da Data Manager API (`events:ingest`). Valida o que a documentação oficial confirma. */
export function createGoogleSimulator(): Simulator {
  return createSimulator((request) => {
    const url = new URL(request.fullUrl);
    if (url.host !== "datamanager.googleapis.com" || url.pathname !== "/v1/events:ingest") {
      return json(404, { error: { code: 404, message: "Not Found", status: "NOT_FOUND" } });
    }
    if (request.method !== "POST") return json(405, { error: { code: 405, message: "Method Not Allowed" } });
    if (!/^Bearer \S+$/.test(request.headers["Authorization"] ?? "")) {
      return json(401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } });
    }

    const body = request.body;
    if (!isRecord(body)) return invalid("body must be an object");

    const destinations = body["destinations"];
    if (!Array.isArray(destinations) || destinations.length < 1) return invalid("destinations is required");
    for (const destination of destinations) {
      const account = isRecord(destination) ? destination["operatingAccount"] : undefined;
      if (!isRecord(account) || account["accountType"] !== "GOOGLE_ADS" || typeof account["accountId"] !== "string") {
        return invalid("operatingAccount must have accountType GOOGLE_ADS and accountId");
      }
      if (!isRecord(destination) || typeof destination["productDestinationId"] !== "string") {
        return invalid("productDestinationId (conversion action) is required");
      }
    }

    const events = body["events"];
    if (!Array.isArray(events) || events.length < 1) return invalid("events is required");
    if (events.length > MAX_EVENTS) return invalid(`At most ${MAX_EVENTS} events can be sent in a single request`);

    for (const event of events) {
      if (!isRecord(event)) return invalid("each event must be an object");
      if (typeof event["eventTimestamp"] !== "string" || !ISO_8601.test(event["eventTimestamp"])) {
        return invalid("eventTimestamp is required and must be ISO 8601");
      }
      if (typeof event["transactionId"] !== "string" || event["transactionId"] === "") return invalid("transactionId is required");
      if (event["eventSource"] !== undefined && event["eventSource"] !== "WEB" && event["eventSource"] !== "APP") {
        return invalid("eventSource must be WEB or APP");
      }
      if (event["conversionValue"] !== undefined) {
        if (typeof event["conversionValue"] !== "number") return invalid("conversionValue must be a number");
        if (typeof event["currency"] !== "string" || !/^[A-Z]{3}$/.test(event["currency"])) return invalid("currency must be a 3-letter ISO 4217 code");
      }

      const adIdentifiers = event["adIdentifiers"];
      const hasAdIdentifier =
        isRecord(adIdentifiers) && ["gclid", "gbraid", "wbraid"].some((k) => typeof adIdentifiers[k] === "string" && adIdentifiers[k] !== "");
      const userData = event["userData"];
      if (!hasAdIdentifier && !isRecord(userData)) return invalid("at least one identifier is required");

      if (userData !== undefined) {
        if (body["encoding"] !== "HEX") return invalid("encoding must be provided and match the one used (HEX)");
        const identifiers = isRecord(userData) ? userData["userIdentifiers"] : undefined;
        if (!Array.isArray(identifiers) || identifiers.length < 1) return invalid("userIdentifiers is required");
        for (const identifier of identifiers) {
          if (!isRecord(identifier) || Object.keys(identifier).length !== 1) return invalid("each UserIdentifier must set exactly ONE field");
          const [key, value] = Object.entries(identifier)[0]!;
          if (key !== "emailAddress" && key !== "phoneNumber") return invalid(`unsupported user identifier: ${key}`);
          if (!isSha256Hex(value)) return invalid(`${key} must be SHA-256 hashed and hex encoded`);
        }
      }
    }

    return json(200, { requestId: "SIMULATED" });
  });
}
