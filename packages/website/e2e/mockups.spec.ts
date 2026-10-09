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
