import { expect, test, type Locator, type Page } from "playwright/test";

const desktopName =
  "Paseo desktop app with coding agents, a conversation, and a code diff open side by side";

async function openHomepage(page: Page) {
  await page.setViewportSize({ width: 1512, height: 930 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Build", exact: true })).toBeVisible();
}

async function viewPhones(page: Page) {
  await page.getByRole("img", { name: "Paseo agent chat", exact: true }).scrollIntoViewIfNeeded();
}

async function expectScreenContentInsidePhone(page: Page, name: string, time: string) {
  const phone = page.getByRole("img", { name, exact: true });
  const clock = phone.getByText(time, { exact: true });
  await expect(clock).toBeVisible();
  await expect(async () => {
    const frame = await phone.boundingBox();
    const content = await clock.boundingBox();
    expect(frame).not.toBeNull();
    expect(content).not.toBeNull();
    if (!frame || !content) throw new Error("Phone screen is not rendered");
    expect(content.x).toBeGreaterThanOrEqual(frame.x);
    expect(content.y).toBeGreaterThanOrEqual(frame.y);
    expect(content.x + content.width).toBeLessThanOrEqual(frame.x + frame.width);
    expect(content.y + content.height).toBeLessThanOrEqual(frame.y + frame.height);
  }).toPass({ timeout: 5000 });
}

async function cornerProportion(mockup: Locator) {
  return mockup.evaluate((element) => {
    const radius = getComputedStyle(element).borderTopLeftRadius.split(" ")[0];
    if (radius.endsWith("%")) return Number.parseFloat(radius) / 100;
    return Number.parseFloat(radius) / element.getBoundingClientRect().width;
  });
}

async function resizeToPhone(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("img", { name: desktopName, exact: true }).scrollIntoViewIfNeeded();
}

test("the three phone mockups show their screen content", async ({ page }) => {
  await openHomepage(page);
  await viewPhones(page);
  await expectScreenContentInsidePhone(page, "Paseo workspace drawer", "18:54");
  await expectScreenContentInsidePhone(page, "Paseo agent chat", "18:53");
  await expectScreenContentInsidePhone(page, "Paseo diff view", "18:55");
});

test("desktop mockup corners shrink in proportion on a phone", async ({ page }) => {
  await openHomepage(page);
  const mockup = page.getByRole("img", { name: desktopName, exact: true });
  const desktopCorner = await cornerProportion(mockup);
  expect(desktopCorner).toBeGreaterThan(0);
  await resizeToPhone(page);
  await expect.poll(() => cornerProportion(mockup)).toBeCloseTo(desktopCorner, 3);
});

async function openAgentPage(page: Page, slug: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/${slug}`);
  await expect(page.getByRole("button", { name: "Build", exact: true })).toBeVisible();
}

async function expectComposerModel(page: Page, label: string) {
  const desktop = page.getByRole("img", { name: desktopName, exact: true });
  await expect(desktop.getByText(label, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Extend", exact: true }).click();
  await expect(desktop.getByText(label, { exact: true })).toHaveCount(1);
  await expect(desktop.getByText(label, { exact: true })).toBeVisible();
  await viewPhones(page);
  await expect(
    page
      .getByRole("img", { name: "Paseo agent chat", exact: true })
      .getByText(label, { exact: true }),
  ).toBeVisible();
}

async function expectPiOverlay(page: Page) {
  await expect(page).toHaveTitle("Pi Agent Mobile and Desktop App, Open Source");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Open source app for the Pi coding agent",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://paseo.sh/pi",
  );
  await expectComposerModel(page, "Pi · Sonnet 4.5");
  const section = page.getByRole("region", { name: "Your Pi setup, with a desktop and mobile UI" });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("heading", { name: "Bring your extensions" })).toBeVisible();
  await expect(
    section.getByText(/pi-subagents, pi-ask-user, pi-mcp-adapter and pi-goal-x/),
  ).toBeVisible();
  await expect(section.getByRole("link", { name: "Set up Paseo" })).toHaveAttribute(
    "href",
    "/docs",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
}

for (const width of [1440, 390]) {
  test(`Pi has its own content and composer at ${width}px`, async ({ page }) => {
    await openAgentPage(page, "pi", width);
    await expectPiOverlay(page);
  });

  test(`an agent without an overlay keeps the shared page at ${width}px`, async ({ page }) => {
    await openAgentPage(page, "opencode", width);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Open source app for OpenCode",
    );
    await expect(
      page.getByText(
        "Run OpenCode on your machine, drive it from your phone or desktop. Open source on both ends, your code stays local.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Your Pi setup, with a desktop and mobile UI" }),
    ).toHaveCount(0);
    await expectComposerModel(page, "GPT-5.6-Sol");
  });
}
