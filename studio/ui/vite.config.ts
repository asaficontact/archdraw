import path from "node:path"
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// The engine is this fork's own build (../../dist, `bun run engine`): the studio renders with exactly the code the
// CLI and the agents use. base './': Tailscale Serve may strip a mount path, so assets and fetches are relative.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@engine": path.resolve(import.meta.dirname, "../../dist/index.js"), "@": path.resolve(import.meta.dirname, "src") } },
  server: { host: "127.0.0.1", proxy: { "/api": process.env.ARCHDRAW_API ?? "http://127.0.0.1:8088" } },
  build: { outDir: "dist", emptyOutDir: false },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
})
