import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PermanentJobError, type JobHandler } from "../../src/shared/jobRunner.js";
import { PostgresJobQueue, enqueueJob } from "../../src/shared/queue.js";
import { createTestPrisma, createTestPrismaWithTimezone, resetDatabase } from "./helpers/db.js";
import { createClock, createTestRunner, drain } from "./helpers/orders.js";

const prisma = createTestPrisma();
const queue = new PostgresJobQueue(prisma);
const clock = createClock();

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set("2026-01-01T12:00:00.000Z");
});
afterAll(async () => {
  await prisma.$disconnect();
});

const enqueue = (n: number | string, runAt = clock.now(), type = "TEST") =>
  prisma.$transaction((tx) => enqueueJob(tx, { type, payload: { n }, dedupKey: `k-${n}`, runAt }));

const claim = (workerId = "w1", lockTimeoutMs = 60_000) => queue.claimNext({ now: clock.now(), lockTimeoutMs, workerId });

describe("fila em PostgreSQL (ADR-026)", () => {
  it("pega o job mais antigo primeiro e marca como RUNNING com a tentativa contada", async () => {
    await enqueue(1, new Date("2026-01-01T11:00:00Z"));
    await enqueue(2, new Date("2026-01-01T10:00:00Z"));
    const job = await claim();
    expect(job).toMatchObject({ type: "TEST", payload: { n: 2 }, attempts: 1 });
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row).toMatchObject({ status: "RUNNING", lockedBy: "w1", attempts: 1 });
  });

  it("devolve null quando não há job", async () => {
    expect(await claim()).toBeNull();
  });

  it("não entrega job agendado para o futuro, e entrega quando o horário chega (fuso horário correto)", async () => {
    await enqueue(1, new Date("2026-01-01T12:00:01.000Z"));
    expect(await claim()).toBeNull();
    clock.advance(999);
    expect(await claim()).toBeNull();
    clock.advance(1);
    expect(await claim()).not.toBeNull();
  });

  it("não entrega o mesmo job duas vezes enquanto ele está RUNNING", async () => {
    await enqueue(1);
    expect(await claim("w1")).not.toBeNull();
    expect(await claim("w2")).toBeNull();
  });

  it("retoma um job RUNNING abandonado depois do tempo de bloqueio", async () => {
    await enqueue(1);
    await claim("w1", 60_000);
    clock.advance(59_000);
    expect(await claim("w2", 60_000)).toBeNull();
    clock.advance(2_000);
    const taken = await claim("w2", 60_000);
    expect(taken).toMatchObject({ attempts: 2 });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: taken!.id } })).lockedBy).toBe("w2");
  });

  it("um worker retomado não consegue concluir o job que perdeu", async () => {
    await enqueue(1);
    const first = (await claim("w1", 1_000))!;
    clock.advance(2_000);
    await claim("w2", 1_000);
    await queue.complete(first, "w1", clock.now());
    expect((await prisma.job.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("RUNNING");
  });

  it("20 jobs e 6 workers concorrentes: cada job é entregue exatamente uma vez (SKIP LOCKED)", async () => {
    for (let n = 0; n < 20; n++) await enqueue(n);
    const claimed: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async (_, w) => {
        for (;;) {
          const job = await claim(`w${w}`);
          if (!job) return;
          claimed.push((job.payload as { n: number }).n);
        }
      }),
    );
    expect(claimed).toHaveLength(20);
    expect(new Set(claimed).size).toBe(20);
  });

  it("rejeita dedupKey repetida", async () => {
    await enqueue(1);
    await expect(enqueue(1)).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("JobRunner: sucesso, retry e falha definitiva", () => {
  it("executa o handler e marca DONE", async () => {
    await enqueue(1);
    const seen: unknown[] = [];
    const runner = createTestRunner(prisma, clock, { handlers: { TEST: async (j) => void seen.push(j.payload) } });
    expect(await runner.runOnce()).toBe(true);
    expect(seen).toEqual([{ n: 1 }]);
    expect((await prisma.job.findFirstOrThrow()).status).toBe("DONE");
    expect(await runner.runOnce()).toBe(false);
  });

  it("falha transitória: volta para PENDING com backoff e erro registrado", async () => {
    await enqueue(1);
    const runner = createTestRunner(prisma, clock, {
      handlers: { TEST: async () => { throw new Error("banco indisponível"); } },
      retryBaseMs: 1000,
    });
    await runner.runOnce();
    const job = await prisma.job.findFirstOrThrow();
    expect(job).toMatchObject({ status: "PENDING", attempts: 1, lockedBy: null });
    expect(job.lastError).toContain("banco indisponível");
    expect(job.runAt).toEqual(new Date(clock.now().getTime() + 1000));

    // Ainda não é hora.
    expect(await runner.runOnce()).toBe(false);
    clock.advance(1000);
    expect(await runner.runOnce()).toBe(true);
    // O backoff dobra na segunda falha.
    expect((await prisma.job.findFirstOrThrow()).runAt).toEqual(new Date(clock.now().getTime() + 2000));
  });

  it("esgotadas as tentativas, vai para FAILED e não repete mais (sem loop infinito)", async () => {
    await enqueue(1);
    let calls = 0;
    const runner = createTestRunner(prisma, clock, {
      handlers: { TEST: async () => { calls++; throw new Error("sempre falha"); } },
      maxAttempts: 3,
    });
    for (let i = 0; i < 10; i++) {
      await runner.runOnce();
      clock.advance(3_600_000);
    }
    expect(calls).toBe(3);
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({ status: "FAILED", attempts: 3 });
  });

  it("erro permanente vai direto para FAILED, sem retry", async () => {
    await enqueue(1);
    let calls = 0;
    const handler: JobHandler = async () => { calls++; throw new PermanentJobError("payload impossível"); };
    const runner = createTestRunner(prisma, clock, { handlers: { TEST: handler } });
    await runner.runOnce();
    clock.advance(3_600_000);
    await runner.runOnce();
    expect(calls).toBe(1);
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({ status: "FAILED", attempts: 1 });
  });

  it("tipo sem handler vai para FAILED, sem loop", async () => {
    await enqueue(1, clock.now(), "DESCONHECIDO");
    const runner = createTestRunner(prisma, clock, { handlers: {} });
    await drain(runner);
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({ status: "FAILED" });
  });

  it("start e stop: processa em segundo plano e encerra", async () => {
    await enqueue(1);
    await enqueue(2);
    const seen: number[] = [];
    const runner = createTestRunner(prisma, clock, {
      handlers: { TEST: async (j) => void seen.push((j.payload as { n: number }).n) },
    });
    const loop = runner.start();
    for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await runner.stop();
    await loop;
    expect(seen.sort()).toEqual([1, 2]);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("garantias de concorrência, verificadas de forma determinística", () => {
  it("SKIP LOCKED: com o job mais antigo travado por outra transação, o worker recebe o próximo sem esperar", async () => {
    await enqueue(1, new Date("2026-01-01T10:00:00Z"));
    await enqueue(2, new Date("2026-01-01T11:00:00Z"));

    let outcome: unknown;
    await prisma.$transaction(async (tx) => {
      // Outro worker está no meio de pegar o job 1 e mantém a linha travada.
      await tx.$queryRaw`SELECT "id" FROM "Job" ORDER BY "runAt", "createdAt" LIMIT 1 FOR UPDATE`;
      const pending = claim("w2");
      outcome = await Promise.race([pending, sleep(1500).then(() => "BLOQUEADO")]);
      // Sem SKIP LOCKED o claim ficaria esperando a transação acima terminar.
      await tx.$executeRaw`SELECT 1`;
      if (outcome === "BLOQUEADO") await pending.catch(() => undefined);
    });
    expect(outcome).not.toBe("BLOQUEADO");
    expect(outcome).toMatchObject({ payload: { n: 2 } });
  });

  it("cada claim acontece em uma única instrução atômica: a linha só é entregue a um worker", async () => {
    await enqueue(1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, w) => claim(`w${w}`)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("claimNext não depende do fuso horário da sessão do banco (teste de regressão)", async () => {
    const base = process.env["TEST_DATABASE_URL"]!;
    const shifted = createTestPrismaWithTimezone(base, "Asia/Tokyo");
    try {
      const shiftedQueue = new PostgresJobQueue(shifted);
      await enqueue(1, new Date("2026-01-01T12:00:01.000Z"));
      expect(await shiftedQueue.claimNext({ now: clock.now(), lockTimeoutMs: 60_000, workerId: "w" })).toBeNull();
      clock.advance(1_000);
      expect(await shiftedQueue.claimNext({ now: clock.now(), lockTimeoutMs: 60_000, workerId: "w" })).not.toBeNull();
    } finally {
      await shifted.$disconnect();
    }
  });
});
