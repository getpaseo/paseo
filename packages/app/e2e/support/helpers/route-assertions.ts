import { expect, type Page } from "@playwright/test";

export async function expectAppRoute(
  page: Page,
  expectedRoute: string,
  options?: { timeout?: number },
): Promise<void> {
  await expect
    .poll(
      () => {
        const current = new URL(page.url());
        return `${current.pathname}${current.search}`;
      },
      { timeout: options?.timeout },
    )
    .toBe(expectedRoute);
}
