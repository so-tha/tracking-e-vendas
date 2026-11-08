import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/shared/logger.js";
import { createTestPrisma } from "./helpers/db.js";

const prisma = createTestPrisma();
const logger = createLogger({ level: "silent" });

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /health", () => {
  it("responde 200 com o banco disponível", async () => {
    const res = await request(createApp({ prisma, logger })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "up" });
  });

  it("responde 503 sem vazar o erro quando o banco falha", async () => {
    const broken = { $queryRaw: () => Promise.reject(new Error("senha incorreta para o usuário tracking")) };
    const res = await request(createApp({ prisma: broken as never, logger })).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", database: "down" });
    expect(JSON.stringify(res.body)).not.toContain("senha");
  });
});

describe("comportamento geral da API", () => {
  it("responde 404 em JSON para rota inexistente", async () => {
    const res = await request(createApp({ prisma, logger })).get("/nao-existe");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("responde 400 para JSON malformado", async () => {
    const res = await request(createApp({ prisma, logger }))
      .post("/health")
      .set("Content-Type", "application/json")
      .send("{ invalido");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_json" });
  });
});
