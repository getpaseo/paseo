import { defineConfig, devices } from "playwright/test";

const baseURL = process.env.WEBSITE_TEST_URL ?? "http://127.0.0.1:8187";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: { baseURL, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: process.env.WEBSITE_TEST_URL
    ? undefined
    : {
        command: "npm run dev -- --host 127.0.0.1 --port 8187 --strictPort",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
      },
});
