import { readFileSync } from "node:fs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma, resetDatabase } from "./helpers/db.js";
import { createClock, createTestKit, drain, testOperators } from "./helpers/orders.js";

/**
 * A coleção do Postman é o contrato entregue da API. Este teste garante que ela cobre todas as rotas
 * do código e que cada requisição dela funciona contra a API real, com o status que ela espera.
 */
const collection = JSON.parse(readFileSync("postman/tracking-hub.postman_collection.json", "utf8"));

interface CollectionRequest {
  name: string;
  method: string;
  /** Caminho com as variáveis do Postman, por exemplo /support/orders/{{orderId}}/tracking. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
  expectedStatus: number;
}

const requests: CollectionRequest[] = collection.item.flatMap((folder: any) =>
  folder.item.map((item: any) => ({
    name: item.name,
    method: item.request.method,
    path: "/" + item.request.url.path.join("/"),
    headers: Object.fromEntries(item.request.header.map((h: any) => [h.key, h.value])),
    body: item.request.body ? JSON.parse(item.request.body.raw) : undefined,
    expectedStatus: Number(/status\((\d{3})\)/.exec(item.event[0].script.exec.join("\n"))?.[1]),
  })),
);

/** Rotas registradas no código, no formato do Postman (":orderId" vira "{{orderId}}"). */
function routesInCode(): string[] {
  const app = readFileSync("src/app.ts", "utf8");
  const prefixes = new Map([...app.matchAll(/app\.use\("(\/[a-z]+)",\s*(\w+)\(/g)].map((m) => [m[2]!, m[1]!]));
  const routes = [...app.matchAll(/app\.(get|post)\("([^"]+)"/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
  const routers = [
    ["src/modules/tracking/routes.ts", "trackingRouter"],
    ["src/modules/orders/routes.ts", "webhooksRouter"],
    ["src/modules/support/routes.ts", "supportRouter"],
  ];
  for (const [file, factory] of routers) {
    for (const m of readFileSync(file!, "utf8").matchAll(/router\.(get|post)\("([^"]+)"/g)) {
      routes.push(`${m[1]!.toUpperCase()} ${prefixes.get(factory!)}${m[2]!.replace(/:(\w+)/g, "{{$1}}")}`);
    }
  }
  return routes.sort();
}

describe("coleção do Postman: conteúdo", () => {
  it("é uma coleção v2.1 com as variáveis esperadas, e a chave de API vazia", () => {
    expect(collection.info.schema).toBe("https://schema.getpostman.com/json/collection/v2.1.0/collection.json");
    const variables = Object.fromEntries(collection.variable.map((v: any) => [v.key, v.value]));
    expect(variables).toEqual({ baseUrl: "http://localhost:3333", orderId: "ORD-001", apiKey: "" });
  });

  it("cobre todas as rotas do código, e só elas", () => {
    expect([...new Set(requests.map((r) => `${r.method} ${r.path}`))].sort()).toEqual(routesInCode());
  });

  it("usa os exemplos do documento original", () => {
    const session = requests.find((r) => r.path === "/tracking/sessions")!.body as any;
    expect(session).toMatchObject({ sessionId: "session_123", pageUrl: "https://checkout.exemplo.com/produto", customer: { email: "cliente@email.com" } });
    const order = requests.find((r) => r.path === "/webhooks/orders")!.body as any;
    expect(order).toMatchObject({ eventId: "evt_123", event: "ORDER_PAID", orderId: "ORD-001", amount: 25500, currency: "USD" });
  });

  it("só as rotas de suporte levam X-API-Key, sempre como variável, e não há credenciais", () => {
    for (const r of requests) {
      const hasKey = "X-API-Key" in r.headers;
      expect(hasKey, r.name).toBe(r.path.startsWith("/support") && !r.name.includes("sem chave"));
      if (hasKey) expect(r.headers["X-API-Key"]).toBe("{{apiKey}}");
    }
    const text = JSON.stringify(collection);
    for (const secret of ["troque-este-segredo", "SIMULATED-", "SEGREDO"]) expect(text).not.toContain(secret);
  });

  it("toda requisição tem um teste com o status esperado", () => {
    for (const r of requests) expect(r.expectedStatus, r.name).toBeGreaterThanOrEqual(200);
  });
});

describe("coleção do Postman: execução contra a API real, na ordem da coleção", () => {
  const prisma = createTestPrisma();
  const clock = createClock("2026-01-10T12:00:00.000Z");
  const app = createApp({ prisma, logger: createLogger({ level: "silent" }), now: clock.now, operators: testOperators });
  const kit = createTestKit(prisma, clock);
  const variables: Record<string, string> = { orderId: "ORD-001", apiKey: testOperators[0]!.secret };
  const fill = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => variables[name] ?? "");

  beforeAll(async () => {
    await resetDatabase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("cada requisição responde com o status que a coleção espera", async () => {
    let processed = false;
    for (const r of requests) {
      // O suporte só enxerga o pedido depois que o worker processou o webhook.
      if (r.path.startsWith("/support") && !processed) {
        await drain(kit.runner);
        processed = true;
      }
      let req = r.method === "GET" ? request(app).get(fill(r.path)) : request(app).post(fill(r.path));
      for (const [key, value] of Object.entries(r.headers)) req = req.set(key, fill(value));
      const res = r.body === undefined ? await req : await req.send(r.body as object);
      expect(res.status, `${r.name}: ${JSON.stringify(res.body)}`).toBe(r.expectedStatus);
    }
  });
});
