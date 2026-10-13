import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Builds for an environment need its env file (ST-142): without web/app/.env.staging a staging
 * build would silently use the production API URL, so `vite build --mode staging` (and with it
 * `bun run build:staging` / `deploy:staging`, however they are run) fails instead.
 */
const REQUIRED_ENV_FILES: Record<string, string> = { staging: ".env.staging" };

export default defineConfig(({ command, mode }) => {
  const required = REQUIRED_ENV_FILES[mode];
  if (
    command === "build" &&
    required &&
    !existsSync(fileURLToPath(new URL(`./${required}`, import.meta.url)))
  ) {
    throw new Error(
      `web/app/${required} is missing: the ${mode} build needs it. See "Staging" in docs/deployment.md`,
    );
  }
  return {
    plugins: [
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { port: 5173, strictPort: true },
  };
});
