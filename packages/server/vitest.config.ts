import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Zod 4 ships dual ESM/CJS; vitest's SSR loader resolves the CJS copy and
    // drops the named `z` export, so inline it to keep the ESM transform.
    server: {
      deps: {
        inline: ["zod"],
      },
    },
    // Fake-timer suites freeze p-throttle's clock, so a real per-second cap deadlocks them.
    env: {
      PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000",
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(__dirname, "./src/test-utils/vitest-setup.ts")],
    pool: "forks",
    fileParallelism: false,
    // Windows runners intermittently starve subprocess-heavy Git tests at the
    // default worker count, leaving child processes alive past their deadlines.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.dev/**"],
  },
});
