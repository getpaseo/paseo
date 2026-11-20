import path from "node:path";
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
    : [
        {
          command: "node e2e/registry-server.mjs",
          url: "http://127.0.0.1:8188/index.json",
        },
        {
          command:
            "node e2e/seed-cache.mjs && npm run build && npm run preview -- --host 127.0.0.1 --port 8187 --strictPort",
          // Probe the server without running the homepage loader's live GitHub requests.
          url: new URL("/logo.svg", baseURL).href,
          stdout: "pipe",
          env: {
            WEBSITE_E2E_PERSIST_PATH: path.resolve(
              import.meta.dirname,
              "../../.artifacts/website-e2e-cache",
            ),
            CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
            PLUGINS_REGISTRY_URL: "http://127.0.0.1:8188",
          },
        },
      ],
});
