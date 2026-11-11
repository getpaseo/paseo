import { test as base, type Request } from "playwright/test";

export { expect } from "playwright/test";
export type { Locator, Page } from "playwright/test";

export const test = base.extend({
  page: async ({ page, baseURL }, run, testInfo) => {
    const pending = new Set<Request>();
    const events: string[] = [];
    const started = Date.now();
    const record = (event: string) => events.push(`${Date.now() - started}ms ${event}`);
    page.on("request", (request) => {
      pending.add(request);
      record(`request ${request.resourceType()} ${new URL(request.url()).pathname}`);
    });
    page.on("requestfinished", (request) => {
      pending.delete(request);
      record(`finished ${new URL(request.url()).pathname}`);
    });
    page.on("requestfailed", (request) => {
      pending.delete(request);
      record(`failed ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`);
    });
    page.on("pageerror", (error) => record(`page error: ${error.message}`));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) record(`navigated ${new URL(frame.url()).pathname}`);
    });
    page.on("response", async (response) => {
      if (response.status() < 500 || new URL(response.url()).origin !== new URL(baseURL!).origin)
        return;
      const body = await response.text().catch(() => "<response body unavailable>");
      console.error(
        `Website HTTP ${response.status()} ${response.url()}\n${JSON.stringify(body.slice(0, 4000))}`,
      );
    });
    await run(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      console.error(
        "Navigation probe",
        JSON.stringify({
          events,
          pending: [...pending].map((request) => new URL(request.url()).pathname),
        }),
      );
    }
  },
});
