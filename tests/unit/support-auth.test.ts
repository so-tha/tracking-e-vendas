import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createOperatorAuthenticator, requireOperator, OPERATOR_LOCAL } from "../../src/modules/support/auth.js";
import { createLogger } from "../../src/shared/logger.js";

const operators = [
  { name: "maria", secret: "segredo-da-maria-com-mais-de-24-chars" },
  { name: "joao", secret: "segredo-do-joao-com-mais-de-24-chars-aaa" },
];
const authenticate = createOperatorAuthenticator(operators);

describe("createOperatorAuthenticator (ADR-024)", () => {
  it("devolve o nome do operador da CONFIGURAÇÃO para a chave correta", () => {
    expect(authenticate(operators[0]!.secret)).toBe("maria");
    expect(authenticate(operators[1]!.secret)).toBe("joao");
  });

  it.each([
    ["ausente", undefined],
    ["vazia", ""],
    ["errada", "chave-errada"],
    ["prefixo da chave", "segredo-da-maria"],
    ["chave com caractere a mais", "segredo-da-maria-com-mais-de-24-chars-"],
    ["maiúsculas diferentes", "SEGREDO-DA-MARIA-COM-MAIS-DE-24-CHARS"],
    ["nome do operador", "maria"],
    ["com espaços nas pontas", " segredo-da-maria-com-mais-de-24-chars "],
  ])("rejeita chave %s", (_name, key) => {
    expect(authenticate(key)).toBeNull();
  });

  it("rejeita chaves gigantes sem processá-las", () => {
    expect(authenticate("a".repeat(10_000))).toBeNull();
  });

  it("sem operadores configurados, nada autentica (seguro por padrão)", () => {
    expect(createOperatorAuthenticator([])("qualquer-coisa")).toBeNull();
  });

  it("a chave de um operador nunca devolve o nome de outro", () => {
    expect(authenticate(operators[0]!.secret)).not.toBe("joao");
  });
});

describe("requireOperator", () => {
  const run = (headers: Record<string, string>) => {
    const logger = createLogger({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const req = { path: "/orders/x/tracking", header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
    const res = { locals: {} as Record<string, unknown>, status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const next = vi.fn();
    requireOperator(authenticate, logger)(req, res, next);
    return { res, next, warn };
  };

  it("com chave válida, guarda o operador da configuração e segue", () => {
    const { res, next } = run({ "x-api-key": operators[0]!.secret });
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals[OPERATOR_LOCAL]).toBe("maria");
  });

  it("com chave inválida, responde 401 sem detalhes e sem seguir", () => {
    const { res, next } = run({ "x-api-key": "errada" });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "unauthorized" });
    expect(res.locals[OPERATOR_LOCAL]).toBeUndefined();
  });

  it("ignora qualquer cabeçalho que tente informar o operador", () => {
    const { res } = run({ "x-api-key": operators[1]!.secret, "x-requested-by": "maria", "x-operator": "maria" });
    expect(res.locals[OPERATOR_LOCAL]).toBe("joao");
  });

  it("não registra a chave no log de acesso negado", () => {
    const { warn } = run({ "x-api-key": "CHAVE-ERRADA-SECRETA" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("CHAVE-ERRADA-SECRETA");
  });
});
