import { Router } from "express";
import type { PrismaClient } from "../../shared/db.js";
import type { Logger } from "../../shared/logger.js";
import { ingestWebhook } from "./ingest.js";

export interface WebhooksRouterDependencies {
  prisma: PrismaClient;
  logger: Logger;
  now: () => Date;
}

export function webhooksRouter({ prisma, logger, now }: WebhooksRouterDependencies): Router {
  const router = Router();

  router.post("/orders", async (req, res) => {
    const outcome = await ingestWebhook(prisma, req.body, now());

    if (outcome.kind === "invalid") {
      // Só caminho e motivo. Nunca ecoa os valores recebidos.
      res.status(400).json({ error: "validation_error", details: outcome.issues });
      return;
    }

    if (outcome.kind === "duplicate") {
      if (outcome.payloadDiffers) {
        logger.warn({ eventId: outcome.eventId }, "eventId repetido com payload diferente. Mantido o original");
      }
      res.status(202).json({ eventId: outcome.eventId, status: "duplicate", ignored: false, warnings: [] });
      return;
    }

    logger.info({ eventId: outcome.eventId, ignored: outcome.kind === "ignored" }, "webhook recebido");
    res.status(202).json({
      eventId: outcome.eventId,
      status: "accepted",
      ignored: outcome.kind === "ignored",
      warnings: outcome.warnings,
    });
  });

  return router;
}
