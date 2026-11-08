import "dotenv/config";
import { execSync } from "node:child_process";

/** Aplica as migrations no banco de teste antes da suíte (ADR-029). SKIP_DB=1 pula (testes unitários). */
export default function setup(): void {
  if (process.env["SKIP_DB"] === "1") return;

  const url = process.env["TEST_DATABASE_URL"];
  if (!url) throw new Error("TEST_DATABASE_URL não definida. Copie .env.example para .env.");

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
