import { Router } from "express";
import type { PrismaClient } from "../../shared/db.js";
import type { Logger } from "../../shared/logger.js";
import { normalizeSessionRequest, sessionRequestSchema } from "./schemas.js";
import { upsertSession } from "./service.js";

export interface TrackingRouterDependencies {
  prisma: PrismaClient;
  logger: Logger;
  now: () => Date;
}

export function trackingRouter({ prisma, logger, now }: TrackingRouterDependencies): Router {
  const router = Router();

  router.post("/sessions", async (req, res) => {
    const parsed = sessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // Só caminho e motivo. Nunca ecoa os valores recebidos.
      res.status(400).json({
        error: "validation_error",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const result = await upsertSession(prisma, normalizeSessionRequest(parsed.data), now());

    logger.info(
      { sessionId: parsed.data.sessionId, created: result.created, conflictFields: result.conflictFields },
      "sessão de tracking registrada",
    );

    // Por ser um endpoint público, a resposta traz só os NOMES dos campos em conflito.
    // Os valores ficam no histórico interno, para não permitir a leitura de dados de uma sessão alheia.
    res.status(result.created ? 201 : 200).json({
      sessionId: parsed.data.sessionId,
      created: result.created,
      complementedFields: result.complementedFields,
      conflictFields: result.conflictFields,
      warnings: result.warnings,
    });
  });

  return router;
}
