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

async function expectPreviewRowsFit(page: Page, source: string, ...rows: string[]) {
  const name = new RegExp(`^${source}`);
  await page.getByRole("tab", { name }).click();
  const preview = page.getByRole("tabpanel", { name });
  await preview.scrollIntoViewIfNeeded();
  for (const row of rows) {
    const text = preview.getByText(row, { exact: true }).filter({ visible: true });
    await expect(text).toBeInViewport({ ratio: 1 });
    expect(await text.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
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

for (const width of [320, 768, 1024]) {
  test(`the complete Pro seat explanation is visible on keyboard focus at ${width}px`, async ({
    page,
  }) => {
    test.skip(Boolean(process.env.WEBSITE_TEST_URL), "Requires the Hub plans fixture");
    await openHub(page, width);
    const tooltip = await focusProSeatHelp(page);
    await expect(tooltip).toContainText("do not count as seats");
    await expect(tooltip).toBeInViewport({ ratio: 1 });
  });
}

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

test("source names remain readable with larger text on a phone", async ({ page }) => {
  await openHub(page, 375);
  await page.addStyleTag({ content: "html { font-size: 125%; }" });
  for (const name of ["GitHub", "Discord", "Schedules", "Webhooks"]) {
    await expectSourceLabelFits(page, name);
  }
});

test("Hub previews have room for their final rows with larger text", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHub(page, 1280);
  await page.addStyleTag({ content: "html { font-size: 125%; }" });
  await waitForHydration(page);
  await expectPreviewRowsFit(page, "GitHub", "Open in Paseo");
  await expectPreviewRowsFit(page, "Discord", "Message #engineering");
});

test("preview results fit on a narrow phone with larger text", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHub(page, 320);
  await page.addStyleTag({ content: "html { font-size: 125%; }" });
  await waitForHydration(page);
  await expectPreviewRowsFit(page, "Discord", "Fix stale worktrees", "getpaseo/paseo#2825");
  await expectPreviewRowsFit(page, "Schedules", "tests passed");
});
