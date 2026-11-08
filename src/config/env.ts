import { z } from "zod";

export interface SupportOperator {
  name: string;
  secret: string;
}

export interface ProvidersConfig {
  meta: { pixelId: string; accessToken: string; apiVersion: string };
  google: { accountId: string; conversionActionId: string; accessToken: string };
  tiktok: { pixelCode: string; accessToken: string };
  utmify: {
    apiToken: string;
    platform: string;
    paymentMethod: "credit_card" | "boleto" | "pix" | "paypal" | "free_price";
    customerName: string;
  };
  redtrack: { trackingDomain: string; conversionType: string };
}

export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  trackingMatchWindowHours: number;
  conversionMaxAttempts: number;
  conversionRetryBaseMs: number;
  workerPollIntervalMs: number;
  jobMaxAttempts: number;
  jobRetryBaseMs: number;
  jobLockTimeoutMs: number;
  providerMode: "simulated";
  providers: ProvidersConfig;
  supportOperators: SupportOperator[];
}

export const MIN_SUPPORT_SECRET_LENGTH = 24;

/** Erro de configuração. A mensagem lista campos e motivos, nunca valores (podem ser segredos). */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuração inválida:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

const supportApiKeys = z.string().transform((raw, ctx) => {
  const operators: SupportOperator[] = [];
  const entries = raw.split(",").map((e) => e.trim()).filter(Boolean);

  if (entries.length === 0) {
    ctx.addIssue({ code: "custom", message: "informe ao menos um operador no formato operador:segredo" });
    return z.NEVER;
  }

  for (const [index, entry] of entries.entries()) {
    const separator = entry.indexOf(":");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "";
    const secret = separator > 0 ? entry.slice(separator + 1).trim() : "";
    const position = `entrada ${index + 1}`;

    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      ctx.addIssue({ code: "custom", message: `${position}: use o formato operador:segredo (operador com letras, números, ponto, hífen ou sublinhado)` });
      return z.NEVER;
    }
    if (secret.length < MIN_SUPPORT_SECRET_LENGTH) {
      ctx.addIssue({ code: "custom", message: `${position} (${name}): o segredo deve ter ao menos ${MIN_SUPPORT_SECRET_LENGTH} caracteres` });
      return z.NEVER;
    }
    if (operators.some((o) => o.name === name)) {
      ctx.addIssue({ code: "custom", message: `${position}: operador "${name}" repetido` });
      return z.NEVER;
    }
    if (operators.some((o) => o.secret === secret)) {
      ctx.addIssue({ code: "custom", message: `${position} (${name}): segredo repetido entre operadores` });
      return z.NEVER;
    }
    operators.push({ name, secret });
  }
  return operators;
});

const text = (fallback: string) => z.string().trim().min(1).default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  DATABASE_URL: z
    .string()
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "deve começar com postgresql://"),
  TRACKING_MATCH_WINDOW_HOURS: z.coerce.number().positive().default(24),
  CONVERSION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  CONVERSION_RETRY_BASE_MS: z.coerce.number().int().positive().default(30_000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  JOB_RETRY_BASE_MS: z.coerce.number().int().positive().default(5000),
  JOB_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  PROVIDER_MODE: z.enum(["simulated"]).default("simulated"),
  // Valores de exercício (sem credenciais reais). Os padrões deixam tudo funcionando em modo simulado.
  META_PIXEL_ID: text("SIMULATED-PIXEL-ID"),
  META_ACCESS_TOKEN: text("SIMULATED-META-TOKEN"),
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/, "formato esperado: v27.0").default("v27.0"),
  GOOGLE_ACCOUNT_ID: text("1234567890"),
  GOOGLE_CONVERSION_ACTION_ID: text("9876543210"),
  GOOGLE_ACCESS_TOKEN: text("SIMULATED-GOOGLE-TOKEN"),
  TIKTOK_PIXEL_CODE: text("SIMULATEDPIXELCODE"),
  TIKTOK_ACCESS_TOKEN: text("SIMULATED-TIKTOK-TOKEN"),
  UTMIFY_API_TOKEN: text("SIMULATED-UTMIFY-TOKEN"),
  UTMIFY_PLATFORM: text("TrackingHub"),
  UTMIFY_PAYMENT_METHOD: z.enum(["credit_card", "boleto", "pix", "paypal", "free_price"]).default("credit_card"),
  UTMIFY_CUSTOMER_NAME: text("Cliente"),
  REDTRACK_TRACKING_DOMAIN: text("track.example.com"),
  REDTRACK_CONVERSION_TYPE: text("Purchase"),
  SUPPORT_API_KEYS: supportApiKeys,
});

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const field = issue.path.join(".") || "(raiz)";
      return issue.code === "invalid_type" && issue.input === undefined
        ? `${field}: variável obrigatória ausente`
        : `${field}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const env = parsed.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    trackingMatchWindowHours: env.TRACKING_MATCH_WINDOW_HOURS,
    conversionMaxAttempts: env.CONVERSION_MAX_ATTEMPTS,
    conversionRetryBaseMs: env.CONVERSION_RETRY_BASE_MS,
    workerPollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    jobMaxAttempts: env.JOB_MAX_ATTEMPTS,
    jobRetryBaseMs: env.JOB_RETRY_BASE_MS,
    jobLockTimeoutMs: env.JOB_LOCK_TIMEOUT_MS,
    providerMode: env.PROVIDER_MODE,
    providers: {
      meta: { pixelId: env.META_PIXEL_ID, accessToken: env.META_ACCESS_TOKEN, apiVersion: env.META_API_VERSION },
      google: { accountId: env.GOOGLE_ACCOUNT_ID, conversionActionId: env.GOOGLE_CONVERSION_ACTION_ID, accessToken: env.GOOGLE_ACCESS_TOKEN },
      tiktok: { pixelCode: env.TIKTOK_PIXEL_CODE, accessToken: env.TIKTOK_ACCESS_TOKEN },
      utmify: {
        apiToken: env.UTMIFY_API_TOKEN,
        platform: env.UTMIFY_PLATFORM,
        paymentMethod: env.UTMIFY_PAYMENT_METHOD,
        customerName: env.UTMIFY_CUSTOMER_NAME,
      },
      redtrack: { trackingDomain: env.REDTRACK_TRACKING_DOMAIN, conversionType: env.REDTRACK_CONVERSION_TYPE },
    },
    supportOperators: env.SUPPORT_API_KEYS,
  };
}
