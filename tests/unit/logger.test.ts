import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/shared/logger.js";

function capture(): { lines: () => Record<string, unknown>[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () => chunks.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

describe("logger (ADR-019: sem dados pessoais nos logs)", () => {
  it("oculta e-mail e telefone em vários formatos de objeto", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ destination: stream });

    logger.info({ email: "cliente@email.com", phone: "+5511999999999" }, "topo");
    logger.info({ customer: { email: "cliente@email.com", phone: "+5511999999999" } }, "customer");
    logger.info({ payload: { customer: { email: "cliente@email.com" } } }, "payload");
    logger.info({ session: { customerEmail: "cliente@email.com", customerPhone: "+5511999999999" } }, "sessao");

    const output = JSON.stringify(lines());
    expect(output).not.toContain("cliente@email.com");
    expect(output).not.toContain("+5511999999999");
    expect(output).toContain("[REDACTED]");
  });

  it("oculta a chave de API do header", () => {
    const { stream, lines } = capture();
    const logger = createLogger({ destination: stream });

    logger.info({ req: { headers: { "x-api-key": "segredo-super-secreto", authorization: "Bearer abc" } } }, "req");

    const output = JSON.stringify(lines());
    expect(output).not.toContain("segredo-super-secreto");
    expect(output).not.toContain("Bearer abc");
  });

  it("preserva campos não sensíveis", () => {
    const { stream, lines } = capture();
    createLogger({ destination: stream }).info({ orderId: "ORD-001" }, "ok");
    expect(lines()[0]).toMatchObject({ orderId: "ORD-001", msg: "ok" });
  });
});
