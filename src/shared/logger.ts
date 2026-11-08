import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

export const REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "email",
  "phone",
  "customerEmail",
  "customerPhone",
  "apiKey",
  "secret",
  "customer.email",
  "customer.phone",
  "payload.customer.email",
  "payload.customer.phone",
  "*.email",
  "*.phone",
  "*.customerEmail",
  "*.customerPhone",
  "*.apiKey",
  "*.secret",
];

export function createLogger(options: { level?: string; destination?: DestinationStream } = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    },
    options.destination,
  );
}
