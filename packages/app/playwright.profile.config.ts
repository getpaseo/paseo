import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./perf",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.PASEO_PROFILE_APP_URL ?? "http://127.0.0.1:8081",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
