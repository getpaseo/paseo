import { expect, test, type Page } from "playwright/test";

test("keeps unrelated agent artwork unchanged while adding the Hermes mark", async ({ page }) => {
  await openSupportedAgents(page);
  await expectGenericAgentMark(page, "CodeWhale");
  await expectVendoredAgentMark(page, "Hermes Agent");
});

async function openSupportedAgents(page: Page) {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { level: 1, name: "Supported agents" })).toBeVisible();
}

async function expectGenericAgentMark(page: Page, name: string) {
  const card = page.getByRole("link", { name, exact: true });
  await expect(card).toBeVisible();
  // Decorative SVGs have no accessible role; the fallback is Lucide's bot mark.
  await expect(card.locator("svg.lucide-bot")).toBeVisible();
}

async function expectVendoredAgentMark(page: Page, name: string) {
  const card = page.getByRole("link", { name, exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator("svg")).toBeVisible();
  await expect(card.locator("svg.lucide-bot")).toHaveCount(0);
}
