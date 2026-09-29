import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";

const REPORT_ID = "fixture:fixture-account";

// Two hours reads "2h ago" for an hour, so the assertion cannot race the clock.
function twoHoursAgo(): string {
  return new Date(Date.now() - 2 * 60 * 60_000).toISOString();
}

function agentEntry(usedPct: number, fetchedAt = "2026-01-01T00:00:00.000Z"): UsageReportEntry {
  return {
    id: REPORT_ID,
    account: { label: "Fixture account" },
    fetchedAt,
    sourceId: "fixture",
    sourceLabel: "Fixture plan",
    icon: '<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="currentColor"/></svg>',
    report: {
      status: "available",
      planLabel: "Test plan",
      windows: [
        { id: "session", label: "Session", usedPct: 3 },
        { id: "weekly", label: "Weekly", usedPct, headline: true },
      ],
    },
  };
}

async function openMockAgent(page: Page) {
  const session = await seedMockAgentWorkspace({
    repoPrefix: "usage-composer-pill-",
    title: "Usage composer pill e2e",
    initialPrompt: "emit 1 coalesced agent stream update for usage composer pill.",
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  return session;
}

test.describe("usage composer pill", () => {
  test("opens the cached report without a request and shows when it was fetched", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usage = await installUsageReportsFixture(page, {
      agentReportIds: [REPORT_ID],
      lists: [[agentEntry(42, twoHoursAgo())]],
    });
    const session = await openMockAgent(page);
    try {
      const pill = page.getByTestId("usage-composer-pill");
      await expect(pill).toContainText("42%", { timeout: 30_000 });
      expect(usage.agentRequests()[0]).toEqual({ agentId: session.agentId });
      expect(usage.listRequests()).toEqual([{ forceRefresh: false, reportIds: [REPORT_ID] }]);

      await pill.click();
      const popover = page.getByTestId("usage-composer-popover");
      await expect(popover.getByText("Fixture plan", { exact: true })).toBeVisible();
      await expect(popover.getByText("Test plan")).toBeVisible();
      await expect(popover.getByText("42%")).toBeVisible();

      await popover.getByTestId("usage-refresh").hover();
      await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated 2h ago");
      await expect(popover.getByTestId("usage-freshness")).toHaveCount(0);
      expect(usage.listRequests()).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  test("refreshes only its report from the popover", async ({ page }) => {
    test.setTimeout(180_000);
    const usage = await installUsageReportsFixture(page, {
      agentReportIds: [REPORT_ID],
      lists: [[agentEntry(42, twoHoursAgo())], () => [agentEntry(64, new Date().toISOString())]],
    });
    const session = await openMockAgent(page);
    try {
      const pill = page.getByTestId("usage-composer-pill");
      await expect(pill).toContainText("42%", { timeout: 30_000 });
      await pill.click();
      const popover = page.getByTestId("usage-composer-popover");
      await expect(popover.getByText("42%")).toBeVisible();

      await popover.getByTestId("usage-refresh").click();
      await usage.waitForListRequests(2);
      expect(usage.listRequests()).toEqual([
        { forceRefresh: false, reportIds: [REPORT_ID] },
        { forceRefresh: true, reportIds: [REPORT_ID] },
      ]);
      await expect(popover.getByText("64%")).toBeVisible();
      await expect(pill).toContainText("64%");
      await expect(popover.getByTestId("usage-refresh")).toBeEnabled();

      // Pressing closes the tooltip; it reopens on the next hover.
      await popover.getByText("Fixture plan", { exact: true }).hover();
      await popover.getByTestId("usage-refresh").hover();
      await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated just now");
      expect(usage.listRequests()).toHaveLength(2);
    } finally {
      await session.cleanup();
    }
  });

  test("keeps the previous report and says so when a refresh fails", async ({ page }) => {
    test.setTimeout(180_000);
    const usage = await installUsageReportsFixture(page, {
      agentReportIds: [REPORT_ID],
      lists: [
        [agentEntry(42, twoHoursAgo())],
        { error: "Usage source timed out" },
        () => [agentEntry(64, new Date().toISOString())],
      ],
    });
    const session = await openMockAgent(page);
    try {
      const pill = page.getByTestId("usage-composer-pill");
      await expect(pill).toContainText("42%", { timeout: 30_000 });
      await pill.click();
      const popover = page.getByTestId("usage-composer-popover");
      const refresh = popover.getByTestId("usage-refresh");

      await refresh.click();
      await usage.waitForListRequests(2);
      await expect(popover.getByTestId("usage-refresh-error")).toHaveText(
        "Unable to refresh usage",
      );
      await expect(popover.getByText("42%")).toBeVisible();
      await expect(pill).toContainText("42%");

      await refresh.click();
      await usage.waitForListRequests(3);
      await expect(popover.getByText("64%")).toBeVisible();
      await expect(popover.getByTestId("usage-refresh-error")).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });

  test("prints the freshness on the card where there is no hover", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const usage = await installUsageReportsFixture(page, {
      agentReportIds: [REPORT_ID],
      lists: [[agentEntry(42, twoHoursAgo())]],
    });
    const session = await openMockAgent(page);
    try {
      const pill = page.getByTestId("usage-composer-pill");
      await expect(pill).toContainText("42%", { timeout: 30_000 });
      await pill.click();
      const popover = page.getByTestId("usage-composer-popover");
      await expect(popover.getByTestId("usage-freshness")).toHaveText("Updated 2h ago");
      expect(usage.listRequests()).toHaveLength(1);
    } finally {
      await session.cleanup();
    }
  });

  test("re-resolves the report ID after a turn and reuses the cached report", async ({ page }) => {
    test.setTimeout(180_000);
    const usage = await installUsageReportsFixture(page, {
      agentReportIds: [REPORT_ID],
      lists: [[agentEntry(42)]],
    });
    const session = await openMockAgent(page);
    try {
      const pill = page.getByTestId("usage-composer-pill");
      await expect(pill).toContainText("42%", { timeout: 30_000 });
      const requestsBeforeTurn = usage.agentRequests().length;
      const listRequestsBeforeTurn = usage.listRequests().length;

      await submitMessage(page, "emit 1 coalesced agent stream update for usage composer pill.");

      await usage.waitForAgentRequests(requestsBeforeTurn + 1);
      expect(usage.agentRequests().at(-1)).toEqual({
        agentId: session.agentId,
      });
      await expect(pill).toContainText("42%");
      expect(usage.listRequests()).toHaveLength(listRequestsBeforeTurn);
    } finally {
      await session.cleanup();
    }
  });

  test("is hidden when the agent has no usage report", async ({ page }) => {
    test.setTimeout(180_000);
    const usage = await installUsageReportsFixture(page, { agentReportIds: [null] });
    const session = await openMockAgent(page);
    try {
      await usage.waitForAgentRequests(1);
      await expect(page.getByTestId("usage-composer-pill")).toHaveCount(0);
      expect(usage.listRequests()).toHaveLength(0);
    } finally {
      await session.cleanup();
    }
  });

  test("is hidden on a host without usage sources", async ({ page }) => {
    test.setTimeout(180_000);
    const usage = await installUsageReportsFixture(page, {
      usageSources: false,
      agentReportIds: [REPORT_ID],
      lists: [[agentEntry(42)]],
    });
    const session = await openMockAgent(page);
    try {
      await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("usage-composer-pill")).toHaveCount(0);
      expect(usage.agentRequests()).toHaveLength(0);
    } finally {
      await session.cleanup();
    }
  });
});
