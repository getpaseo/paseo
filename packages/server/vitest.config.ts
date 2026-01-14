import path from "node:path";
import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true";

export default defineConfig({
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(__dirname, "./src/test-utils/vitest-setup.ts")],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks: 4,
      },
    },
    // Skip e2e and integration tests in CI - they require real agent binaries or cross-package imports
    exclude: isCI
      ? [
          "**/*.e2e.test.ts",
          "**/opencode-agent.test.ts",
          "**/codex-mcp-agent.test.ts",
          "**/claude-agent.test.ts",
          "**/claude-agent-commands.test.ts",
          "**/worktree.test.ts",
          "**/terminal-manager.test.ts",
          "**/node_modules/**",
        ]
      : ["**/node_modules/**"],
  },
});
