import { test as base } from "playwright/test";

export { expect } from "playwright/test";
export type { Locator, Page } from "playwright/test";

export const test = base.extend({
  page: async ({ page, baseURL }, run) => {
    page.on("response", async (response) => {
      if (response.status() < 500 || new URL(response.url()).origin !== new URL(baseURL!).origin)
        return;
      const body = await response.text().catch(() => "<response body unavailable>");
      console.error(
        `Website HTTP ${response.status()} ${response.url()}\n${JSON.stringify(body.slice(0, 4000))}`,
      );
    });
    await run(page);
  },
});
