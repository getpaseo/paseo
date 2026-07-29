import { defineConfig, devices } from "@playwright/test";

// E2E_METRO_PORT is set dynamically by global-setup.ts after finding a free port
// This allows multiple test runs in parallel across different worktrees
const baseURL =
  process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_METRO_PORT ?? "8081"}`;

export default defineConfig({
  testDir: "./e2e/browser",
  globalSetup: "./e2e/support/global-setup.ts",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  // Every worker owns its daemon state, so independent tests can run concurrently
  // even when they live in the same behavior-focused spec file.
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? (process.env.CI ? "2" : "1")),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env.E2E_RECORD_VIDEO === "1" ? "on" : "retain-on-failure",
  },
  projects: [
    {
      name: "browser",
      testIgnore: ["**/*.real.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "real-provider",
      testMatch: ["**/*.real.spec.ts"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Note: Metro is started by global-setup.ts on a dynamic port to allow parallel test runs
});
