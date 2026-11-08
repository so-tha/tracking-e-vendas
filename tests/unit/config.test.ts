import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";

const SECRET_A = "segredo-do-operador-maria-0001";
const SECRET_B = "segredo-do-operador-joao-00002";

const validEnv = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SUPPORT_API_KEYS: `maria:${SECRET_A},joao:${SECRET_B}`,
};

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error("esperava ConfigError");
}

describe("loadConfig", () => {
  it("aplica os padrões documentados", () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      nodeEnv: "development",
      port: 3333,
      trackingMatchWindowHours: 24,
      conversionMaxAttempts: 5,
      conversionRetryBaseMs: 30_000,
      workerPollIntervalMs: 1000,
      jobMaxAttempts: 5,
      jobRetryBaseMs: 5000,
      jobLockTimeoutMs: 300_000,
      providerMode: "simulated",
    });
  });

  it("provedores: aplica os valores de exercício (nenhuma credencial real é necessária)", () => {
    expect(loadConfig(validEnv).providers).toEqual({
      meta: { pixelId: "SIMULATED-PIXEL-ID", accessToken: "SIMULATED-META-TOKEN", apiVersion: "v27.0" },
      google: { accountId: "1234567890", conversionActionId: "9876543210", accessToken: "SIMULATED-GOOGLE-TOKEN" },
      tiktok: { pixelCode: "SIMULATEDPIXELCODE", accessToken: "SIMULATED-TIKTOK-TOKEN" },
      utmify: { apiToken: "SIMULATED-UTMIFY-TOKEN", platform: "TrackingHub", paymentMethod: "credit_card", customerName: "Cliente" },
      redtrack: { trackingDomain: "track.example.com", conversionType: "Purchase" },
    });
  });

  it("provedores: aceita sobrescrever pelo ambiente e remove espaços das pontas", () => {
    const { providers } = loadConfig({
      ...validEnv,
      META_PIXEL_ID: "  123  ",
      UTMIFY_PAYMENT_METHOD: "pix",
      REDTRACK_CONVERSION_TYPE: "Upsell Purchase",
      META_API_VERSION: "v28.1",
    });
    expect(providers.meta).toMatchObject({ pixelId: "123", apiVersion: "v28.1" });
    expect(providers.utmify.paymentMethod).toBe("pix");
    expect(providers.redtrack.conversionType).toBe("Upsell Purchase");
  });

  it.each([
    ["UTMIFY_PAYMENT_METHOD", "cartao"],
    ["META_API_VERSION", "27"],
    ["META_API_VERSION", "latest"],
    ["META_ACCESS_TOKEN", "   "],
    ["REDTRACK_TRACKING_DOMAIN", ""],
  ])("provedores: rejeita %s=%j", (key, value) => {
    expect(() => loadConfig({ ...validEnv, [key]: value })).toThrow(ConfigError);
  });

  it("converte variáveis numéricas vindas como texto", () => {
    const config = loadConfig({ ...validEnv, PORT: "4000", TRACKING_MATCH_WINDOW_HOURS: "48" });
    expect(config.port).toBe(4000);
    expect(config.trackingMatchWindowHours).toBe(48);
  });

  it("associa cada chave ao nome do operador definido na configuração", () => {
    const { supportOperators } = loadConfig(validEnv);
    expect(supportOperators).toEqual([
      { name: "maria", secret: SECRET_A },
      { name: "joao", secret: SECRET_B },
    ]);
  });

  it("aceita segredo contendo dois-pontos", () => {
    const secret = "parte1:parte2-com-mais-de-vinte-e-quatro";
    const { supportOperators } = loadConfig({ ...validEnv, SUPPORT_API_KEYS: `maria:${secret}` });
    expect(supportOperators[0]?.secret).toBe(secret);
  });

  it("falha quando DATABASE_URL está ausente", () => {
    const problems = problemsOf({ SUPPORT_API_KEYS: validEnv.SUPPORT_API_KEYS });
    expect(problems.join()).toContain("DATABASE_URL");
  });

  it("falha quando SUPPORT_API_KEYS está ausente", () => {
    const problems = problemsOf({ DATABASE_URL: validEnv.DATABASE_URL });
    expect(problems.join()).toContain("SUPPORT_API_KEYS");
  });

  it("rejeita segredo curto sem revelar o valor", () => {
    const problems = problemsOf({ ...validEnv, SUPPORT_API_KEYS: "maria:curto" });
    expect(problems.join()).toContain("ao menos 24 caracteres");
    expect(problems.join()).not.toContain("curto");
  });

  it("rejeita operador repetido", () => {
    const problems = problemsOf({
      ...validEnv,
      SUPPORT_API_KEYS: `maria:${SECRET_A},maria:${SECRET_B}`,
    });
    expect(problems.join()).toContain("repetido");
  });

  it("rejeita o mesmo segredo para operadores diferentes", () => {
    const problems = problemsOf({
      ...validEnv,
      SUPPORT_API_KEYS: `maria:${SECRET_A},joao:${SECRET_A}`,
    });
    expect(problems.join()).toContain("segredo repetido");
  });

  it("rejeita entrada sem separador", () => {
    const problems = problemsOf({ ...validEnv, SUPPORT_API_KEYS: SECRET_A });
    expect(problems.join()).toContain("operador:segredo");
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "70000"],
    ["TRACKING_MATCH_WINDOW_HOURS", "0"],
    ["CONVERSION_MAX_ATTEMPTS", "0"],
    ["JOB_MAX_ATTEMPTS", "0"],
    ["WORKER_POLL_INTERVAL_MS", "0"],
    ["JOB_LOCK_TIMEOUT_MS", "-1"],
    ["PROVIDER_MODE", "real"],
    ["DATABASE_URL", "mysql://x"],
  ])("rejeita %s=%s", (key, value) => {
    expect(() => loadConfig({ ...validEnv, [key]: value })).toThrow(ConfigError);
  });
});
