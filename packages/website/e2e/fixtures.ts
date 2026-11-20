import { expect, test as base, type Page } from "playwright/test";

export { expect } from "playwright/test";
export type { Locator, Page } from "playwright/test";

/**
 * Waits until the page has hydrated. Server-rendered content shows before that, but it has no
 * click handlers yet, and the router scrolls the window back to the top when it hydrates.
 * The language button stays disabled until the render after that reset.
 */
export async function waitForHydration(page: Page) {
  await expect(page.getByRole("button", { name: /^(Language|语言)/ }).first()).toBeEnabled();
}

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
