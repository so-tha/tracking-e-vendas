import { hostname } from "node:os";
import { ConfigError, loadConfig } from "./config/env.js";
import { DELIVER_CONVERSION } from "./modules/conversions/create.js";
import { createDeliverConversion } from "./modules/conversions/deliver.js";
import { createSimulatedEnvironment } from "./modules/conversions/providers/index.js";
import { PROCESS_ORDER_EVENT } from "./modules/orders/ingest.js";
import { createProcessOrderEvent } from "./modules/orders/process.js";
import { createPrismaClient } from "./shared/db.js";
import { JobRunner } from "./shared/jobRunner.js";
import { createLogger } from "./shared/logger.js";
import { PostgresJobQueue } from "./shared/queue.js";

const logger = createLogger();

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    logger.fatal(error.message);
    process.exit(1);
  }
  throw error;
}

const prisma = createPrismaClient(config.databaseUrl);
const now = () => new Date();

// Modo simulado (PROVIDER_MODE=simulated): nenhum tráfego real é feito (ADR-036).
const { registry: providers } = createSimulatedEnvironment(config.providers, { now });

const runner = new JobRunner({
  queue: new PostgresJobQueue(prisma),
  handlers: {
    [PROCESS_ORDER_EVENT]: createProcessOrderEvent(prisma, now, {
      matchWindowHours: config.trackingMatchWindowHours,
      providers,
    }),
    [DELIVER_CONVERSION]: createDeliverConversion(prisma, now, {
      providers,
      maxAttempts: config.conversionMaxAttempts,
      retryBaseMs: config.conversionRetryBaseMs,
    }),
  },
  logger,
  workerId: `${hostname()}:${process.pid}`,
  maxAttempts: config.jobMaxAttempts,
  retryBaseMs: config.jobRetryBaseMs,
  lockTimeoutMs: config.jobLockTimeoutMs,
  pollIntervalMs: config.workerPollIntervalMs,
  now,
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "encerrando worker");
  await runner.stop();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info("worker iniciado");
await runner.start();
