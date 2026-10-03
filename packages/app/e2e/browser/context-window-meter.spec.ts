import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import {
  type AgentUsageScript,
  closeContextWindowSheet,
  contextWindowSheet,
  expectRefreshButtons,
  expiredLogin,
  gate,
  hoverContextWindowMeter,
  onWorkLogin,
  openAgentWithContextWindow,
  pressContextWindowMeter,
  qaScreenshot,
  refreshUsageCard,
  reloadAgent,
  scriptAgentUsage,
  usageCard,
} from "../support/helpers/context-window";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { claudeAndCodexReports, expectUnpinnableRows } from "../support/helpers/usage-sidebar-item";

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
});

const DESKTOP = { width: 1440, height: 900 };
const COMPACT = { width: 390, height: 844 };
const LOGIN_EXPIRED = /^Login expired .*Run claude to refresh it\.$/;

type OpenDetails = (page: Page) => Promise<Locator>;
type Shot = (state: string) => Promise<void>;

/** Two reports on the agent's login stream in; the details show each card as it arrives. */
async function expectCardsToStreamIn(
  page: Page,
  usage: AgentUsageScript,
  openDetails: OpenDetails,
  shot: Shot,
): Promise<Locator> {
  const [claude, codex] = claudeAndCodexReports();
  const first = gate();
  const second = gate();
  usage.answerNext({
    stream: [first.promise, onWorkLogin(claude!), second.promise, onWorkLogin(codex!)],
  });
  const details = await openDetails(page);
  await expect(details.getByText("Loading usage...", { exact: true })).toBeVisible();
  await shot("loading");

  first.open();
  await expect(
    usageCard(details, "claude:work").getByText("work@example.com", { exact: true }),
  ).toBeVisible();
  await expect(details.getByText("Loading usage...", { exact: true })).toHaveCount(0);
  await expect(usageCard(details, "codex:work")).toHaveCount(0);
  await shot("streaming");

  second.open();
  await expect(
    usageCard(details, "codex:work").getByText("Session", { exact: true }),
  ).toBeVisible();
  // Only the agent's login, never the host's default one, and no pins.
  await expect(details.getByText("dev@example.com", { exact: true })).toHaveCount(0);
  await expectUnpinnableRows(details);
  await expect(details.getByText("Updated just now", { exact: true })).toHaveCount(2);
  return details;
}

async function expectFailedRequestSentence(
  page: Page,
  usage: AgentUsageScript,
  openDetails: OpenDetails,
  shot: Shot,
): Promise<void> {
  usage.answerNext({ error: "Unknown agent" });
  await reloadAgent(page);
  const details = await openDetails(page);
  await expect(
    details.getByText("Unable to load usage: Unknown agent", { exact: true }),
  ).toBeVisible();
  await shot("error");
}

async function expectOnlyContextWindowWithoutUsage(
  page: Page,
  usage: AgentUsageScript,
  openDetails: OpenDetails,
  shot: Shot,
): Promise<void> {
  usage.stopReportingUsage();
  await reloadAgent(page);
  const details = await openDetails(page);
  await expect(details.getByText("25% used", { exact: true })).toBeVisible();
  await expect(details.getByText("Loading usage...", { exact: true })).toHaveCount(0);
  await expect(details.getByText("work@example.com", { exact: true })).toHaveCount(0);
  await shot("unsupported");
}

for (const theme of ["light", "dark"] as const) {
  test(`the context window tooltip shows the agent's usage (${theme})`, async ({ page }) => {
    test.setTimeout(240_000);
    const [claude] = claudeAndCodexReports();
    const usage = await scriptAgentUsage(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize(DESKTOP);
    const session = await openAgentWithContextWindow(page);
    const shot: Shot = (state) => qaScreenshot(page, `tooltip-desktop-${theme}-${state}`);

    try {
      await test.step("reports stream in one card at a time, without Refresh", async () => {
        const tooltip = await expectCardsToStreamIn(page, usage, hoverContextWindowMeter, shot);
        // The tooltip cannot be pressed, so its cards have no Refresh.
        await expectRefreshButtons(tooltip, 0);
        await shot("ready");
        expect(usage.agentRequests()).toEqual([session.agentId]);
      });

      await test.step("a report with a problem shows it on the card", async () => {
        usage.answerNext([expiredLogin(onWorkLogin(claude!))]);
        await reloadAgent(page);
        const tooltip = await hoverContextWindowMeter(page);
        await expect(tooltip.getByText(LOGIN_EXPIRED)).toBeVisible();
        await shot("problem");
      });

      await test.step("a failed request says so in a sentence", async () => {
        await expectFailedRequestSentence(page, usage, hoverContextWindowMeter, shot);
      });

      await test.step("a host without usage reports shows only the context window", async () => {
        await expectOnlyContextWindowWithoutUsage(page, usage, hoverContextWindowMeter, shot);
        // One request per open that had usage; this one sends none.
        expect(usage.agentRequests()).toHaveLength(3);
      });
    } finally {
      await session.cleanup();
    }
  });

  test(`the context window sheet shows the agent's usage and refreshes it (${theme})`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const [claude] = claudeAndCodexReports();
    const usage = await scriptAgentUsage(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize(COMPACT);
    const session = await openAgentWithContextWindow(page);
    const shot: Shot = (state) => qaScreenshot(page, `sheet-compact-${theme}-${state}`);

    try {
      await test.step("reports stream in one card at a time, each with Refresh", async () => {
        const sheet = await expectCardsToStreamIn(page, usage, pressContextWindowMeter, shot);
        await expectRefreshButtons(sheet, 2);
        await shot("ready");
        expect(usage.agentRequests()).toEqual([session.agentId]);
      });

      await test.step("Refresh replaces the card with the source's new report", async () => {
        usage.answerNext([expiredLogin(onWorkLogin(claude!))]);
        const sheet = contextWindowSheet(page);
        await refreshUsageCard(sheet, "Claude");
        await expect(sheet.getByText(LOGIN_EXPIRED)).toBeVisible();
        expect(usage.refreshedReports()).toEqual([["claude:work"]]);
        await shot("problem");
      });

      await test.step("Close dismisses the sheet", async () => {
        await closeContextWindowSheet(page);
      });

      await test.step("a failed request says so in a sentence", async () => {
        await expectFailedRequestSentence(page, usage, pressContextWindowMeter, shot);
      });

      await test.step("a host without usage reports shows only the context window", async () => {
        await expectOnlyContextWindowWithoutUsage(page, usage, pressContextWindowMeter, shot);
        expect(usage.agentRequests()).toHaveLength(2);
      });
    } finally {
      await session.cleanup();
    }
  });
}
