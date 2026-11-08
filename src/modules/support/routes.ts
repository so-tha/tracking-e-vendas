import { Router } from "express";
import { z } from "zod";
import type { SupportOperator } from "../../config/env.js";
import type { PrismaClient } from "../../shared/db.js";
import type { Logger } from "../../shared/logger.js";
import { OPERATOR_LOCAL, createOperatorAuthenticator, requireOperator } from "./auth.js";
import { reprocessOrder } from "./reprocess.js";
import { loadTrackingView } from "./tracking.js";

export interface SupportRouterDependencies {
  prisma: PrismaClient;
  logger: Logger;
  now: () => Date;
  operators: readonly SupportOperator[];
}

const orderIdSchema = z.string().trim().min(1).max(200);
const reprocessBodySchema = z.object({ includePermanentFailures: z.boolean().optional() });

export function supportRouter({ prisma, logger, now, operators }: SupportRouterDependencies): Router {
  const router = Router();

  // Tudo em /support exige chave de operador.
  router.use(requireOperator(createOperatorAuthenticator(operators), logger));

  router.get("/orders/:orderId/tracking", async (req, res) => {
    const orderId = orderIdSchema.safeParse(req.params["orderId"]);
    if (!orderId.success) {
      res.status(400).json({ error: "validation_error", details: [{ path: "orderId", message: "orderId inválido" }] });
      return;
    }
    const view = await loadTrackingView(prisma, orderId.data);
    if (!view) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }
    res.status(200).json(view);
  });

  router.post("/orders/:orderId/reprocess", async (req, res) => {
    const orderId = orderIdSchema.safeParse(req.params["orderId"]);
    const body = reprocessBodySchema.safeParse(req.body ?? {});
    if (!orderId.success || !body.success) {
      res.status(400).json({
        error: "validation_error",
        details: [
          ...(orderId.success ? [] : [{ path: "orderId", message: "orderId inválido" }]),
          ...(body.success ? [] : body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))),
        ],
      });
      return;
    }

    // O responsável é o operador da chave validada. Qualquer "requestedBy" enviado pelo cliente é ignorado.
    const operator = res.locals[OPERATOR_LOCAL] as string;
    const outcome = await reprocessOrder(prisma, {
      orderId: orderId.data,
      operator,
      includePermanentFailures: body.data.includePermanentFailures ?? false,
      now: now(),
    });
    if (!outcome) {
      res.status(404).json({ error: "order_not_found" });
      return;
    }

    logger.info(
      { orderId: orderId.data, operator, requestId: outcome.requestId, includePermanentFailures: outcome.includePermanentFailures },
      "reprocessamento solicitado",
    );
    res.status(202).json(outcome);
  });

  return router;
}
