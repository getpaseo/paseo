import { defineConfig, devices } from "@playwright/test";

const baseURL =
  process.env.E2E_BASE_URL ??
  `http://localhost:${process.env.E2E_METRO_PORT ?? "8081"}`;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "Desktop Firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
