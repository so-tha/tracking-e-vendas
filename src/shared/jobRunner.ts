import type { Logger } from "./logger.js";
import { computeBackoffMs } from "./retry.js";
import type { ClaimedJob, JobQueue } from "./queue.js";

/** O handler pode pedir uma nova execução em um horário próprio (ex.: Retry-After de um provedor). */
export interface JobRetry {
  retryAt: Date;
  reason: string;
}

export type JobHandler = (job: ClaimedJob) => Promise<void | JobRetry>;

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export interface JobRunnerOptions {
  queue: JobQueue;
  handlers: Record<string, JobHandler>;
  logger: Logger;
  workerId: string;
  maxAttempts: number;
  retryBaseMs: number;
  lockTimeoutMs: number;
  pollIntervalMs: number;
  now?: () => Date;
  random?: () => number;
}

export class JobRunner {
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: JobRunnerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Processa no máximo um job. Devolve true se havia job. */
  async runOnce(): Promise<boolean> {
    const { queue, handlers, logger, workerId, maxAttempts, retryBaseMs, lockTimeoutMs, random } = this.options;

    const job = await queue.claimNext({ now: this.now(), lockTimeoutMs, workerId });
    if (!job) return false;

    const handler = handlers[job.type];
    if (!handler) {
      logger.error({ jobId: job.id, type: job.type }, "job sem handler registrado");
      await queue.fail(job, workerId, { error: `sem handler para o tipo ${job.type}`, now: this.now() });
      return true;
    }

    try {
      const result = await handler(job);
      if (result && "retryAt" in result) {
        // Reagendamento pedido pelo próprio handler. Não conta contra JOB_MAX_ATTEMPTS: quem limita é o handler.
        await queue.retry(job, workerId, { error: result.reason, runAt: result.retryAt, now: this.now() });
      } else {
        await queue.complete(job, workerId, this.now());
      }
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const permanent = error instanceof PermanentJobError;

      if (permanent || job.attempts >= maxAttempts) {
        logger.error({ jobId: job.id, type: job.type, attempts: job.attempts, permanent }, "job falhou definitivamente");
        await queue.fail(job, workerId, { error: message, now: this.now() });
      } else {
        const delay = computeBackoffMs({ attempt: job.attempts, baseMs: retryBaseMs, random });
        const now = this.now();
        logger.warn({ jobId: job.id, type: job.type, attempts: job.attempts, retryInMs: delay }, "job falhou, será repetido");
        await queue.retry(job, workerId, { error: message, runAt: new Date(now.getTime() + delay), now });
      }
    }
    return true;
  }

  /** Laço do worker. Dorme quando não há job e termina depois de stop(). */
  start(): Promise<void> {
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (error) {
          this.options.logger.error({ err: error }, "erro no laço do worker");
        }
        if (!worked && this.running) await this.sleep(this.options.pollIntervalMs);
      }
    })();
    return this.loop;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
