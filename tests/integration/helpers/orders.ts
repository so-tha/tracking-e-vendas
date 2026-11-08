import type { ProvidersConfig } from "../../../src/config/env.js";
import { DELIVER_CONVERSION } from "../../../src/modules/conversions/create.js";
import { createDeliverConversion } from "../../../src/modules/conversions/deliver.js";
import { createSimulatedEnvironment, type SimulatedEnvironment } from "../../../src/modules/conversions/providers/index.js";
import { PROCESS_ORDER_EVENT } from "../../../src/modules/orders/ingest.js";
import { createProcessOrderEvent } from "../../../src/modules/orders/process.js";
import type { PrismaClient } from "../../../src/shared/db.js";
import { JobRunner } from "../../../src/shared/jobRunner.js";
import { createLogger } from "../../../src/shared/logger.js";
import { PostgresJobQueue } from "../../../src/shared/queue.js";

/** Exemplo exato do documento original (seção 4). */
export const orderPaid = (overrides: Record<string, unknown> = {}) => ({
  eventId: "evt_123",
  event: "ORDER_PAID",
  orderId: "ORD-001",
  sessionId: "session_123",
  amount: 25500,
  currency: "USD",
  customer: { email: "cliente@email.com" },
  customFields: { source: "facebook", campaign: "black-friday", content: "criativo-01", affiliateCode: "AFF-001" },
  ...overrides,
});

export interface TestClock {
  now: () => Date;
  set: (iso: string) => void;
  advance: (ms: number) => void;
}

export function createClock(iso = "2026-01-01T12:00:00.000Z"): TestClock {
  let current = new Date(iso).getTime();
  return {
    now: () => new Date(current),
    set: (value) => {
      current = new Date(value).getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export const testProvidersConfig: ProvidersConfig = {
  meta: { pixelId: "SIM-PIXEL-1", accessToken: "SEGREDO-META-TOKEN", apiVersion: "v27.0" },
  google: { accountId: "1234567890", conversionActionId: "9876543210", accessToken: "SEGREDO-GOOGLE-TOKEN" },
  tiktok: { pixelCode: "SIMPIXELCODE", accessToken: "SEGREDO-TIKTOK-TOKEN" },
  utmify: { apiToken: "SEGREDO-UTMIFY-TOKEN", platform: "TrackingHub", paymentMethod: "credit_card", customerName: "Cliente" },
  redtrack: { trackingDomain: "track.exemplo.com", conversionType: "Purchase" },
};

export interface TestKitOptions {
  runner?: Partial<ConstructorParameters<typeof JobRunner>[0]>;
  matchWindowHours?: number;
  /** Total de tentativas por conversão. */
  conversionMaxAttempts?: number;
  conversionRetryBaseMs?: number;
}

export interface TestKit extends SimulatedEnvironment {
  runner: JobRunner;
}

/** Runner com os dois handlers reais e os cinco provedores simulados. */
export function createTestKit(prisma: PrismaClient, clock: TestClock, options: TestKitOptions = {}): TestKit {
  const environment = createSimulatedEnvironment(testProvidersConfig, { now: clock.now });
  const runner = new JobRunner({
    queue: new PostgresJobQueue(prisma),
    handlers: {
      [PROCESS_ORDER_EVENT]: createProcessOrderEvent(prisma, clock.now, {
        matchWindowHours: options.matchWindowHours ?? 24,
        providers: environment.registry,
      }),
      [DELIVER_CONVERSION]: createDeliverConversion(prisma, clock.now, {
        providers: environment.registry,
        maxAttempts: options.conversionMaxAttempts ?? 4,
        retryBaseMs: options.conversionRetryBaseMs ?? 1000,
        random: () => 1,
      }),
    },
    logger: createLogger({ level: "silent" }),
    workerId: "test-worker",
    maxAttempts: 3,
    retryBaseMs: 1000,
    lockTimeoutMs: 60_000,
    pollIntervalMs: 10,
    now: clock.now,
    random: () => 1,
    ...options.runner,
  });
  return { ...environment, runner };
}

/** Compatível com os testes anteriores: só devolve o runner. */
export function createTestRunner(
  prisma: PrismaClient,
  clock: TestClock,
  overrides: Partial<ConstructorParameters<typeof JobRunner>[0]> = {},
  matchWindowHours = 24,
): JobRunner {
  return createTestKit(prisma, clock, { runner: overrides, matchWindowHours }).runner;
}

/** Processa jobs até a fila esvaziar. */
export async function drain(runner: JobRunner, limit = 200): Promise<number> {
  let processed = 0;
  while (processed < limit && (await runner.runOnce())) processed++;
  return processed;
}

/** Operadores de teste. O nome vem da configuração, nunca do cliente (ADR-024). */
export const testOperators = [
  { name: "maria", secret: "segredo-de-teste-da-maria-0001" },
  { name: "joao", secret: "segredo-de-teste-do-joao-00002" },
];
