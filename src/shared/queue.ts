import { Prisma } from "../generated/prisma/client.js";
import type { PrismaClient } from "./db.js";

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  dedupKey: string;
  attempts: number;
}

export interface ClaimOptions {
  now: Date;
  /** Um job RUNNING bloqueado há mais tempo que isso é considerado abandonado e pode ser retomado. */
  lockTimeoutMs: number;
  workerId: string;
}

export interface JobQueue {
  claimNext(options: ClaimOptions): Promise<ClaimedJob | null>;
  complete(job: ClaimedJob, workerId: string, now: Date): Promise<void>;
  retry(job: ClaimedJob, workerId: string, update: { error: string; runAt: Date; now: Date }): Promise<void>;
  fail(job: ClaimedJob, workerId: string, update: { error: string; now: Date }): Promise<void>;
}

export interface NewJob {
  type: string;
  payload: Prisma.InputJsonValue;
  dedupKey: string;
  runAt: Date;
}

/** Enfileira dentro de uma transação existente, junto com a gravação que originou o job. */
export async function enqueueJob(tx: Prisma.TransactionClient, job: NewJob): Promise<void> {
  await tx.job.create({ data: { ...job, createdAt: job.runAt } });
}

const MAX_ERROR_LENGTH = 1000;
const truncate = (text: string) => (text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text);

export class PostgresJobQueue implements JobQueue {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * FOR UPDATE SKIP LOCKED: vários workers pegam jobs ao mesmo tempo sem pegar o mesmo.
   * Quem encontra uma linha travada por outro pula para a próxima, em vez de esperar.
   */
  async claimNext({ now, lockTimeoutMs, workerId }: ClaimOptions): Promise<ClaimedJob | null> {
    const staleBefore = new Date(now.getTime() - lockTimeoutMs);
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE "Job"
      SET "status" = 'RUNNING'::"JobStatus",
          "lockedAt" = ${now},
          "lockedBy" = ${workerId},
          "attempts" = "attempts" + 1,
          "updatedAt" = ${now}
      WHERE "id" = (
        SELECT "id" FROM "Job"
        WHERE ("status" = 'PENDING'::"JobStatus" AND "runAt" <= ${now})
           OR ("status" = 'RUNNING'::"JobStatus" AND "lockedAt" < ${staleBefore})
        ORDER BY "runAt" ASC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "type", "payload", "dedupKey", "attempts"`;
    return rows[0] ?? null;
  }

  /** As três transições só valem se este worker ainda é o dono do job (ele pode ter sido retomado por outro). */
  private owned(job: ClaimedJob, workerId: string) {
    return { id: job.id, lockedBy: workerId, status: "RUNNING" as const };
  }

  async complete(job: ClaimedJob, workerId: string, now: Date): Promise<void> {
    await this.prisma.job.updateMany({
      where: this.owned(job, workerId),
      data: { status: "DONE", lockedAt: null, lockedBy: null, lastError: null, updatedAt: now },
    });
  }

  async retry(job: ClaimedJob, workerId: string, { error, runAt, now }: { error: string; runAt: Date; now: Date }): Promise<void> {
    await this.prisma.job.updateMany({
      where: this.owned(job, workerId),
      data: { status: "PENDING", runAt, lockedAt: null, lockedBy: null, lastError: truncate(error), updatedAt: now },
    });
  }

  async fail(job: ClaimedJob, workerId: string, { error, now }: { error: string; now: Date }): Promise<void> {
    await this.prisma.job.updateMany({
      where: this.owned(job, workerId),
      data: { status: "FAILED", lockedAt: null, lockedBy: null, lastError: truncate(error), updatedAt: now },
    });
  }
}
