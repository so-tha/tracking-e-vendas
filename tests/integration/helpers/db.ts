import "dotenv/config";
import { createPrismaClient, type PrismaClient } from "../../../src/shared/db.js";

export function createTestPrisma(): PrismaClient {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) throw new Error("TEST_DATABASE_URL não definida.");
  assertTestDatabase(url);
  return createPrismaClient(url);
}

/** Trava de segurança: nunca limpar tabelas de um banco que não seja de teste. */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Recusado: "${name}" não parece um banco de teste (nome deve terminar em _test).`);
  }
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

/** Cliente cuja sessão no PostgreSQL usa outro fuso horário. Serve para provar que não dependemos do fuso do servidor. */
export function createTestPrismaWithTimezone(url: string, timezone: string): PrismaClient {
  assertTestDatabase(url);
  const withOptions = new URL(url);
  withOptions.searchParams.set("options", `-c timezone=${timezone}`);
  return createPrismaClient(withOptions.toString());
}
