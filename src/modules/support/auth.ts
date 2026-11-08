import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { SupportOperator } from "../../config/env.js";
import type { Logger } from "../../shared/logger.js";

const MAX_KEY_LENGTH = 256;

export type Authenticator = (presentedKey: string | undefined) => string | null;

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/**
 * Autentica pela chave de API.
 *
 * - Compara o SHA-256 da chave apresentada com o de TODOS os operadores usando `timingSafeEqual`, sem parar
 *   no primeiro acerto: o tempo gasto não revela qual operador existe nem quantos caracteres batem.
 *   Comparar os hashes (e não os textos) também elimina a diferença de tamanho entre as chaves.
 * - O nome do operador vem EXCLUSIVAMENTE da configuração associada à chave validada.
 */
export function createOperatorAuthenticator(operators: readonly SupportOperator[]): Authenticator {
  const entries = operators.map((operator) => ({ name: operator.name, digest: digest(operator.secret) }));

  return (presentedKey) => {
    if (!presentedKey || presentedKey.length > MAX_KEY_LENGTH) return null;
    const presented = digest(presentedKey);
    let match: string | null = null;
    for (const entry of entries) {
      const equal = timingSafeEqual(presented, entry.digest);
      if (equal && match === null) match = entry.name;
    }
    return match;
  };
}

/** Operador autenticado, disponível para os handlers. Nunca vem de campo enviado pelo cliente. */
export const OPERATOR_LOCAL = "operator";

export function requireOperator(authenticate: Authenticator, logger: Logger): RequestHandler {
  return (req, res, next) => {
    const operator = authenticate(req.header("x-api-key"));
    if (!operator) {
      // Sem detalhes: não revela se a chave estava ausente, errada ou de outro formato. A chave nunca é logada.
      logger.warn({ path: req.path }, "acesso ao suporte negado");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.locals[OPERATOR_LOCAL] = operator;
    next();
  };
}
