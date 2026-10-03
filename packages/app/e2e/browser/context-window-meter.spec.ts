import type { Locator } from "@playwright/test";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";

const USAGE_ICON =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>';

function contextUsageReport(): UsageReportEntry {
  return {
    id: "mock:account",
    account: { label: "dev@example.com" },
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "mock",
    sourceLabel: "Mock plan",
    icon: USAGE_ICON,
    report: {
      status: "available",
      windows: [{ id: "session", label: "Session", usedPct: 42 }],
    },
  };
}

// Where the progress arc is painted, as its centroid relative to the ring's centre in pixels.
// Reads the rendered pixels, so any rotation that does not reach the screen counts as none.
async function progressArcCentroid(meter: Locator): Promise<{ x: number; y: number }> {
  const ring = meter.locator("svg");
  const progressColor = await ring
    .locator("circle")
    .last()
    .evaluate((circle) => getComputedStyle(circle).stroke);
  const screenshot = await ring.screenshot();
  return ring.evaluate(
    async (_svg, { png, color }) => {
      const image = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${png}`)).blob(),
      );
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const [r, g, b] = color.match(/\d+/g)!.map(Number);
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const i = (y * image.width + x) * 4;
          const distance =
            Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
          if (distance < 40) {
            sumX += x;
            sumY += y;
            count += 1;
          }
        }
      }
      if (count === 0) {
        throw new Error(`No pixels painted in the progress colour ${color}`);
      }
      return { x: sumX / count - image.width / 2, y: sumY / count - image.height / 2 };
    },
    { png: screenshot.toString("base64"), color: progressColor },
  );
}

test.describe("context window meter", () => {
  test("draws usage clockwise from twelve o'clock", async ({ page }) => {
    test.setTimeout(180_000);
    // 32,000 of the mock's 128,000-token window: a quarter, from twelve to three o'clock.
    const session = await seedMockAgentWorkspace({
      repoPrefix: "context-window-meter-",
      title: "Context window meter e2e",
      initialPrompt: "emit 32000 byte file agent stream payload",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const meter = page.getByTestId("context-window-meter");
      await expect(meter).toHaveAccessibleName(/25%/, { timeout: 30_000 });

      const centroid = await progressArcCentroid(meter);
      expect(centroid.x).toBeGreaterThan(1);
      expect(centroid.y).toBeLessThan(-1);
    } finally {
      await session.cleanup();
    }
  });

  test("shows the host's plan limits in the context tooltip", async ({ page }) => {
    test.setTimeout(180_000);
    const usage = await installUsageReportsFixture(page, { lists: [[contextUsageReport()]] });
    const session = await seedMockAgentWorkspace({
      repoPrefix: "context-window-usage-",
      title: "Context window usage tooltip",
      initialPrompt: "emit 32000 byte file agent stream payload",
    });
    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      const meter = page.getByTestId("context-window-meter");
      await expect(meter).toHaveAccessibleName(/25%/, { timeout: 30_000 });
      await meter.hover();
      await usage.waitForListRequests(1);

      const tooltip = page.getByTestId("context-window-meter-tooltip");
      await expect(tooltip.getByText("Mock plan", { exact: true })).toBeVisible();
      await expect(tooltip.getByText("42% used", { exact: true })).toBeVisible();
      const pin = tooltip.getByRole("checkbox", { name: /Pin Mock plan Session/ });
      await pin.click();
      await expect(pin).toBeChecked();

      await tooltip.getByRole("button", { name: "Refresh Mock plan" }).click();
      await usage.waitForListRequests(2);
      expect(usage.listRequests()[1]).toMatchObject({
        forceRefresh: true,
        reportIds: ["mock:account"],
      });
    } finally {
      await session.cleanup();
    }
  });
});
