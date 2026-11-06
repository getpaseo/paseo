import { defineConfig, devices } from "@playwright/test";

// Starts its own Metro and isolated daemon through the e2e global setup and fixtures, so the
// measurement never touches a developer daemon.
export default defineConfig({
  testDir: "./perf",
  testMatch: ["many-agent-tabs-cpu.spec.ts"],
  globalSetup: "./e2e/support/global-setup.ts",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
  },
});
