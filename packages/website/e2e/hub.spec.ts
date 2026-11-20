import { expect, test, type Page } from "./fixtures";

async function openHub(page: Page) {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/hub");
  await expect(page.getByRole("heading", { name: "Paseo Hub", level: 1 })).toBeVisible();
}

async function focusProSeatHelp(page: Page) {
  const pro = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Pro", exact: true }) });
  const help = pro.getByLabel(/^Seats are Hub members/).locator("..");
  await help.scrollIntoViewIfNeeded();
  await help.focus();
  return pro.getByRole("tooltip");
}

test("Hub fits a viewport narrower than its page frame", async ({ page }) => {
  await openHub(page);
  const { contentWidth, viewportWidth } = await page.evaluate(() => ({
    contentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(contentWidth).toBeLessThanOrEqual(viewportWidth);
});

test("the complete Pro seat explanation is visible on keyboard focus", async ({ page }) => {
  test.skip(Boolean(process.env.WEBSITE_TEST_URL), "Requires the Hub plans fixture");
  await openHub(page);
  const tooltip = await focusProSeatHelp(page);
  await expect(tooltip).toContainText("do not count as seats");
  await expect(tooltip).toBeInViewport({ ratio: 1 });
});

test("the Slack starter forwards the mention and declares a thread reply", async ({ page }) => {
  await openHub(page);
  const starter = page.locator("pre").filter({ hasText: "name: slack-help" });
  await expect(starter).toContainText("${{ paseo.prompt }}");
  await expect(starter).toContainText("hub.reply");
  await expect(starter).toContainText("slack.reply:");
});
