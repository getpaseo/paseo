import { expect, test, waitForHydration, type Page } from "./fixtures";

async function openHub(page: Page, width = 1024) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/hub");
  await expect(page.getByRole("heading", { name: "Paseo Hub", level: 1 })).toBeVisible();
}

async function tabIntoNextPreview(page: Page) {
  await waitForHydration(page);
  await page.getByRole("tab", { name: /^Slack/ }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Tab");
}

async function readPreviewOnFocus(page: Page) {
  return page.getByRole("tabpanel").evaluateHandle((panel) => {
    const atFocus = { label: "" };
    panel.addEventListener(
      "focus",
      () => {
        atFocus.label = panel.querySelector('[role="img"]')?.getAttribute("aria-label") ?? "";
      },
      { once: true },
    );
    return atFocus;
  });
}

async function expectSourceLabelFits(page: Page, name: string) {
  const label = page.getByRole("tab", { name }).getByText(name, { exact: true });
  await expect(label).toBeVisible();
  expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
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

test("keyboard focus enters the selected preview with its current content", async ({ page }) => {
  await openHub(page);
  const atFocus = await readPreviewOnFocus(page);
  await tabIntoNextPreview(page);
  await expect(page.getByRole("tabpanel", { name: /^GitHub/ })).toBeFocused();
  expect((await atFocus.jsonValue()).label).toMatch(/^GitHub issue/);
});

test("source names fit on a narrow phone", async ({ page }) => {
  await openHub(page, 320);
  await expectSourceLabelFits(page, "Schedules");
  await expectSourceLabelFits(page, "Webhooks");
});
