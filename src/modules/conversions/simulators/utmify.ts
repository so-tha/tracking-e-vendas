import { SEVEN_DAYS_MS } from "../types.js";
import { createSimulator, isRecord, json, type Simulator } from "./base.js";

const PAYMENT_METHODS = ["credit_card", "boleto", "pix", "paypal", "free_price"];
const STATUSES = ["waiting_payment", "paid", "refused", "refunded", "chargedback"];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const TRACKING_KEYS = ["src", "sck", "utm_source", "utm_campaign", "utm_medium", "utm_content", "utm_term"];

const parseUtc = (text: string) => new Date(`${text.replace(" ", "T")}Z`).getTime();
const isNullableString = (v: unknown) => v === null || typeof v === "string";

/**
 * Simulador do endpoint de vendas da UTMify. Valida o esquema oficial (docs.utmify.com.br/envio-de-vendas).
 * Os códigos HTTP e o corpo de erro não são documentados pela UTMify.
 */
export function createUtmifySimulator(options: { now?: () => Date } = {}): Simulator {
  const now = options.now ?? (() => new Date());

  return createSimulator((request) => {
    const url = new URL(request.fullUrl);
    if (url.host !== "api.utmify.com.br" || url.pathname !== "/api-credentials/orders") return json(404, { message: "Not Found" });
    if (request.method !== "POST") return json(405, { message: "Method Not Allowed" });
    if (!request.headers["x-api-token"]) return json(401, { message: "API_CREDENTIAL_NOT_FOUND" });

    const invalidFields: string[] = [];
    const body = request.body;
    if (!isRecord(body)) return json(400, { message: "invalid body", invalidFields: ["body"] });
    const check = (condition: boolean, field: string) => {
      if (!condition) invalidFields.push(field);
    };
    const text = (v: unknown) => typeof v === "string" && v !== "";

    check(text(body["orderId"]), "orderId");
    check(text(body["platform"]), "platform");
    check(PAYMENT_METHODS.includes(body["paymentMethod"] as string), "paymentMethod");
    check(STATUSES.includes(body["status"] as string), "status");

    const createdAt = body["createdAt"];
    check(typeof createdAt === "string" && DATE_FORMAT.test(createdAt), "createdAt");
    if (typeof createdAt === "string" && DATE_FORMAT.test(createdAt)) {
      check(now().getTime() - parseUtc(createdAt) <= SEVEN_DAYS_MS, "createdAt (older than 7 days)");
    }
    for (const key of ["approvedDate", "refundedAt"] as const) {
      check(key in body && (body[key] === null || (typeof body[key] === "string" && DATE_FORMAT.test(body[key] as string))), key);
    }

    const customer = body["customer"];
    if (isRecord(customer)) {
      check(text(customer["name"]), "customer.name");
      check(text(customer["email"]), "customer.email");
      check("phone" in customer && isNullableString(customer["phone"]), "customer.phone");
      check("document" in customer && isNullableString(customer["document"]), "customer.document");
    } else {
      check(false, "customer");
    }

    const products = body["products"];
    if (Array.isArray(products) && products.length > 0) {
      products.forEach((product, i) => {
        const p = isRecord(product) ? product : {};
        check(text(p["id"]), `products[${i}].id`);
        check(text(p["name"]), `products[${i}].name`);
        check("planId" in p && isNullableString(p["planId"]), `products[${i}].planId`);
        check("planName" in p && isNullableString(p["planName"]), `products[${i}].planName`);
        check(Number.isInteger(p["quantity"]) && (p["quantity"] as number) >= 1, `products[${i}].quantity`);
        check(Number.isInteger(p["priceInCents"]), `products[${i}].priceInCents`);
      });
    } else {
      check(false, "products");
    }

    const tracking = body["trackingParameters"];
    if (isRecord(tracking)) {
      for (const key of TRACKING_KEYS) check(key in tracking && isNullableString(tracking[key]), `trackingParameters.${key}`);
    } else {
      check(false, "trackingParameters");
    }

    const commission = body["commission"];
    if (isRecord(commission)) {
      for (const key of ["totalPriceInCents", "gatewayFeeInCents", "userCommissionInCents"]) {
        check(Number.isInteger(commission[key]), `commission.${key}`);
      }
      if (commission["currency"] !== undefined) check(typeof commission["currency"] === "string" && /^[A-Z]{3}$/.test(commission["currency"]), "commission.currency");
    } else {
      check(false, "commission");
    }

    if (invalidFields.length > 0) return json(400, { message: "invalid fields", invalidFields });
    if (body["isTest"] === true) return json(200, { result: "OK", saved: false });
    return json(200, { result: "OK", saved: true });
  });
}
