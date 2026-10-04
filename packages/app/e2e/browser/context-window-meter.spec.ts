import type { Locator, Page } from "@playwright/test";
import { expect, test as base } from "../support/fixtures";
import {
  composerLocator,
  expectComposerVisible,
  submitMessageWithButton,
} from "../support/helpers/composer";
import {
  type AgentUsageScript,
  closeContextWindowSheet,
  contextWindowDetails,
  expectRefreshButtons,
  expiredLogin,
  gate,
  hoverContextWindowMeter,
  leaveContextWindowMeter,
  type MockAgentSession,
  moveOntoContextWindowDetails,
  onPersonalLogin,
  onWorkLogin,
  openAgent,
  pressContextWindowMeter,
  qaScreenshot,
  refreshUsageCard,
  reloadAgent,
  scriptAgentUsage,
  seedAgentWithContextWindow,
  usageCard,
} from "../support/helpers/context-window";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { claudeAndCodexReports, expectUnpinnableRows } from "../support/helpers/usage-sidebar-item";
import { installLoginUsage } from "../support/helpers/usage-login";

const test = base.extend<{ agent: MockAgentSession }>({
  agent: async ({ page: _page }, provide) => {
    const agent = await seedAgentWithContextWindow();
    try {
      await provide(agent);
    } finally {
      await agent.cleanup();
    }
  },
});

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

for (const layout of [
  {
    name: "desktop",
    viewport: DESKTOP,
    open: hoverContextWindowMeter,
    close: leaveContextWindowMeter,
  },
  {
    name: "compact",
    viewport: COMPACT,
    open: pressContextWindowMeter,
    close: closeContextWindowSheet,
  },
]) {
  test(`shows account usage before the first turn (${layout.name})`, async ({ page }) => {
    test.setTimeout(180_000);
    const source = await installLoginUsage({
      status: "available",
      windows: [{ id: "session", label: "Session", usedPct: 31 }],
    });
    try {
      const agent = await seedMockAgentWorkspace({
        repoPrefix: "context-window-empty-",
        title: "Agent before its first turn",
      });
      try {
        await page.setViewportSize(layout.viewport);
        await openAgent(page, agent);

        await test.step("the empty meter opens context details and account usage", async () => {
          const details = await layout.open(page, "Context window: No context data");
          await expect(details.getByText("No context data", { exact: true })).toBeVisible();
          await expect(details.getByText("0% used", { exact: true })).toHaveCount(0);
          await expect(details.getByText(/tokens$/)).toHaveCount(0);
          const account = usageCard(details, "login-journey:account");
          await expect(account.getByText("Session", { exact: true })).toBeVisible();
          await expect(account.getByText("31%", { exact: true })).toBeVisible();
          await qaScreenshot(page, `context-without-data-${layout.name}`);
          await layout.close(page);
        });

        await test.step("the first context reading replaces the empty state", async () => {
          await submitMessageWithButton(page, "emit 32000 byte file agent stream payload");
          const details = await layout.open(page);
          await expect(details.getByText("25% used", { exact: true })).toBeVisible();
          await expect(details.getByText("32k / 128k tokens", { exact: true })).toBeVisible();
          await expect(details.getByText("No context data", { exact: true })).toHaveCount(0);
          await expect(
            usageCard(details, "login-journey:account").getByText("31%", { exact: true }),
          ).toBeVisible();
        });
      } finally {
        await agent.cleanup();
      }
    } finally {
      await source.cleanup();
    }
  });
}

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
  test(`the context window hover card shows the agent's usage (${theme})`, async ({
    page,
    agent,
  }) => {
    test.setTimeout(240_000);
    const [claude] = claudeAndCodexReports();
    const usage = await scriptAgentUsage(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize(DESKTOP);
    await openAgent(page, agent);
    const shot: Shot = (state) => qaScreenshot(page, `hover-card-desktop-${theme}-${state}`);

    await test.step("reports stream in one card at a time, each with Refresh", async () => {
      const card = await expectCardsToStreamIn(page, usage, hoverContextWindowMeter, shot);
      await expectRefreshButtons(card, 2);
      await shot("ready");
      expect(usage.agentRequests()).toEqual([agent.agentId]);
    });

    await test.step("the card stays open while the pointer moves onto it", async () => {
      const card = contextWindowDetails(page);
      await moveOntoContextWindowDetails(page, card);
      await page.waitForTimeout(300);
      await expect(card).toBeVisible();
    });

    await test.step("Refresh replaces the card with the source's new report", async () => {
      usage.answerNext([expiredLogin(onWorkLogin(claude!))]);
      const card = contextWindowDetails(page);
      await refreshUsageCard(card, "Claude");
      await expect(card.getByText(LOGIN_EXPIRED)).toBeVisible();
      expect(usage.refreshedReports()).toEqual([["claude:work"]]);
    });

    await test.step("after a resume under another login, only that login shows", async () => {
      // Closed while the old login's report is still on its way.
      await leaveContextWindowMeter(page);
      const slowSource = gate();
      usage.answerNext({ stream: [slowSource.promise, onWorkLogin(claude!)] });
      const closedEarly = await hoverContextWindowMeter(page);
      await expect(closedEarly.getByText("Loading usage...", { exact: true })).toBeVisible();
      await leaveContextWindowMeter(page);

      const resumed = gate();
      const finished = gate();
      usage.answerNext({
        stream: [resumed.promise, onPersonalLogin(claude!), finished.promise],
      });
      const card = await hoverContextWindowMeter(page);
      await expect(card.getByText("Loading usage...", { exact: true })).toBeVisible();
      await expect(card.getByText("work@example.com", { exact: true })).toHaveCount(0);

      // The old login's report lands during the new request, before the new login's.
      slowSource.open();
      resumed.open();
      await expect(
        usageCard(card, "claude:personal").getByText("personal@example.com", { exact: true }),
      ).toBeVisible();
      await expect(card.getByText("work@example.com", { exact: true })).toHaveCount(0);
      finished.open();
    });

    await test.step("a report with a problem shows it on the card", async () => {
      usage.answerNext([expiredLogin(onWorkLogin(claude!))]);
      await reloadAgent(page);
      const card = await hoverContextWindowMeter(page);
      await expect(card.getByText(LOGIN_EXPIRED)).toBeVisible();
      await shot("problem");
    });

    await test.step("a failed request says so in a sentence", async () => {
      await expectFailedRequestSentence(page, usage, hoverContextWindowMeter, shot);
    });

    await test.step("a host without usage reports shows only the context window", async () => {
      await expectOnlyContextWindowWithoutUsage(page, usage, hoverContextWindowMeter, shot);
      // One request per open that had usage; this one sends none.
      expect(usage.agentRequests()).toHaveLength(5);
    });
  });

  test(`the context window sheet shows the agent's usage and refreshes it (${theme})`, async ({
    page,
    agent,
  }) => {
    test.setTimeout(240_000);
    const [claude] = claudeAndCodexReports();
    const usage = await scriptAgentUsage(page);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize(COMPACT);
    await openAgent(page, agent);
    const shot: Shot = (state) => qaScreenshot(page, `sheet-compact-${theme}-${state}`);

    await test.step("reports stream in one card at a time, each with Refresh", async () => {
      const sheet = await expectCardsToStreamIn(page, usage, pressContextWindowMeter, shot);
      await expectRefreshButtons(sheet, 2);
      // Without hover, each card prints its freshness instead of a Refresh tooltip.
      await expect(sheet.getByText("Updated just now", { exact: true })).toHaveCount(2);
      await shot("ready");
      expect(usage.agentRequests()).toEqual([agent.agentId]);
    });

    await test.step("Refresh replaces the card with the source's new report", async () => {
      usage.answerNext([expiredLogin(onWorkLogin(claude!))]);
      const sheet = contextWindowDetails(page);
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
  });
}

test("context details support keyboard entry and dismiss when the viewport moves", async ({
  page,
  agent,
}) => {
  const usage = await scriptAgentUsage(page);
  await page.setViewportSize(DESKTOP);
  await openAgent(page, agent);
  await submitMessageWithButton(page, "withhold synthetic user message until interrupted");
  const stop = page.getByRole("button", { name: /stop|cancel/i }).first();
  await expect(stop).toBeVisible();
  const [claude] = claudeAndCodexReports();
  usage.answerNext([onPersonalLogin(claude!)]);
  const meter = page.getByTestId("context-window-meter");
  const trigger = page.getByRole("button", {
    name: (await meter.getAttribute("aria-label"))!,
    exact: true,
  });
  await expect(trigger).toHaveAttribute("tabindex", "0");
  await trigger.focus();
  const details = contextWindowDetails(page);
  await expect(details).toBeVisible();
  await expect(details.getByRole("button", { name: "Refresh Claude", exact: true })).toBeVisible();
  await trigger.press("ArrowDown");
  await expect(details.getByRole("button", { name: "Refresh Claude", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(stop).toBeVisible();
  await expect(trigger).toBeFocused();
  for (const key of ["Enter", " "]) {
    usage.answerNext([onPersonalLogin(claude!)]);
    await trigger.press(key);
    await expect(details).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(stop).toBeVisible();
    await expect(trigger).toBeFocused();
  }
  usage.answerNext([onPersonalLogin(claude!)]);
  await trigger.press("ArrowDown");
  await expect(details).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 850 });
  await expect(details).toHaveCount(0);
});

test("pointer hovering context details preserves composer focus", async ({ page, agent }) => {
  const usage = await scriptAgentUsage(page);
  await page.setViewportSize(DESKTOP);
  await openAgent(page, agent);
  const [claude] = claudeAndCodexReports();
  usage.answerNext([onPersonalLogin(claude!)]);
  const input = composerLocator(page);
  await input.focus();
  await hoverContextWindowMeter(page);
  await expect(input).toBeFocused();
  await leaveContextWindowMeter(page);
  await expect(input).toBeFocused();
});
