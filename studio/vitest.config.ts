import { defineConfig } from "vitest/config"
export default defineConfig({ test: { include: ["core/test/**/*.test.ts", "server/test/**/*.test.ts"], testTimeout: 30000, pool: "forks" } })
