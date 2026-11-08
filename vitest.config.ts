import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/setup/global-setup.ts"],
    // Os testes de integração compartilham um banco. Arquivos rodam em sequência.
    fileParallelism: false,
  },
});
