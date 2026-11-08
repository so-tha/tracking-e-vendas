import express, { type ErrorRequestHandler, type Express } from "express";
import type { SupportOperator } from "./config/env.js";
import { supportRouter } from "./modules/support/routes.js";
import { webhooksRouter } from "./modules/orders/routes.js";
import { trackingRouter } from "./modules/tracking/routes.js";
import type { PrismaClient } from "./shared/db.js";
import type { Logger } from "./shared/logger.js";

export interface AppDependencies {
  prisma: PrismaClient;
  logger: Logger;
  /** Relógio injetável, para testes determinísticos. */
  now?: () => Date;
  /** Operadores com acesso a /support. Sem nenhum, todo acesso a /support é negado. */
  operators?: readonly SupportOperator[];
}

const HEALTH_TIMEOUT_MS = 2000;

export function createApp({ prisma, logger, now = () => new Date(), operators = [] }: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req, res) => {
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS).unref(),
        ),
      ]);
      res.status(200).json({ status: "ok", database: "up" });
    } catch (error) {
      logger.error({ err: error }, "health check falhou");
      // Não expõe o erro ao cliente.
      res.status(503).json({ status: "degraded", database: "down" });
    }
  });

  app.use("/tracking", trackingRouter({ prisma, logger, now }));
  app.use("/webhooks", webhooksRouter({ prisma, logger, now }));
  app.use("/support", supportRouter({ prisma, logger, now, operators }));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    // JSON malformado vindo do cliente.
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    logger.error({ err: error }, "erro não tratado");
    res.status(500).json({ error: "internal_error" });
  };
  app.use(errorHandler);

  return app;
}
