import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config/env.js";
import { createPrismaClient } from "./shared/db.js";
import { createLogger } from "./shared/logger.js";

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
const app = createApp({ prisma, logger, operators: config.supportOperators });
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, "API ouvindo");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "encerrando");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
