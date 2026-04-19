import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // Testcontainers container is reused across suites, so everything must
    // run in the same process.
    pool: "forks",
    fileParallelism: false,
  },
});
