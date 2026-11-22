import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { UsageReport, UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { openSettingsSection } from "../support/helpers/settings";
import { gate } from "../support/helpers/context-window";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { getServerId } from "../support/helpers/server-id";
import { seedSidebarFooterPreferences } from "../support/helpers/sidebar-nav-settings";
import {
  installUsageReportsFixture,
  type UsageListRequest,
  type UsageReportsFixture,
} from "../support/helpers/usage-reports";
import {
  installLoginUsage,
  expectLoginUsageFreshness,
  installCodexWindowUsage,
  expectCodexReportedWindows,
  refreshLoginUsage,
  hoverUsageWindow,
} from "../support/helpers/usage-login";
import {
  claudeAndCodexReports,
  closeUsage,
  expectPinnedUsage,
  openCompactSidebar,
  openUsageFromIcon,
  openUsageFromItem,
  pinRow,
  openUsageOptions,
  openUsageSources,
  closeUsageOptions,
  pickUsageHost,
  usageModalHost,
  dragUsageCardAbove,
  recordUsageCardPositionsAfterRelease,
  expectUsageCardOrder,
  expectUsageOptionsFitContent,
  setUsageCardOn,
  showUsageAs,
  refreshAllUsage,
  togglePin,
  usageItem,
  usageModal,
} from "../support/helpers/usage-sidebar-item";

const emptyHome = path.join(tmpdir(), `paseo-usage-empty-${randomUUID()}`);
test.use({
  e2eDaemonEnvironment: {
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    CODEX_HOME: emptyHome,
    CLAUDE_CONFIG_DIR: emptyHome,
    XDG_DATA_HOME: emptyHome,
    PI_CODING_AGENT_DIR: emptyHome,
    COPILOT_TOKEN: "",
    GITHUB_TOKEN: "",
    GITHUB_PAT: "",
    CURSOR_ACCESS_TOKEN: "",
    CURSOR_TOKEN: "",
    GROK_API_KEY: "",
    GROK_TOKEN: "",
    KIMI_TOKEN: "",
    KIMI_API_KEY: "",
    KIMI_CODE_HOME: emptyHome,
    MINIMAX_API_KEY: "",
    ZAI_API_KEY: "",
    GLM_API_KEY: "",
  },
});

// These tests read the sidebar summary and pin windows, which both need the Usage item on.
test.beforeEach(async ({ page }) => {
  await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
});

function forcedRefreshes(usage: UsageReportsFixture): UsageListRequest[] {
  return usage.listRequests().filter((request) => request.forceRefresh);
}

// Two hours reads "2h ago" for an hour, so the assertion cannot race the clock.
function twoHoursAgo(): string {
  return new Date(Date.now() - 2 * 60 * 60_000).toISOString();
}

/** Set PASEO_QA_SCREENSHOT_DIR to keep a QA screenshot. */
async function qaScreenshot(page: Page, name: string, target: "page" | "summary" = "page") {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  const file = path.join(directory, `${name}.png`);
  if (target === "summary") {
    await usageItem(page).screenshot({ path: file });
    return;
  }
  await page.screenshot({ path: file });
}

function weeklyReport(sourceId: string, usedPct: number): UsageReportEntry {
  return {
    id: `${sourceId}:a`,
    account: {},
    fetchedAt: twoHoursAgo(),
    sourceId,
    sourceLabel: `${sourceId} plan`,
    report: { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct }] },
  };
}

function accountReport(sourceId: string, account: string, usedPct: number): UsageReportEntry {
  return {
    ...weeklyReport(sourceId, usedPct),
    id: `${sourceId}:${account}`,
    account: { label: account },
  };
}

function installReversedUsageRefresh(page: Page) {
  const initial = [weeklyReport("opencode", 31), weeklyReport("openai", 12)];
  const refreshed = [weeklyReport("openai", 22), weeklyReport("opencode", 41)];
  return installUsageReportsFixture(page, {
    lists: [(request) => (request.forceRefresh ? refreshed : initial)],
  });
}

async function openUsageSummaryAtWidth(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await gotoAppShell(page);
  if (width === 390) await openCompactSidebar(page);
  await expectPinnedUsage(page, ["12% Weekly", "31% Weekly"]);
  await openUsageFromItem(page);
}

async function expectUsageProviderOrder(page: Page, summary: string[]) {
  const group = page.getByTestId(`usage-host-${getServerId()}`);
  await expect(group.getByText(/^(opencode|openai) plan$/)).toHaveText([
    "openai plan",
    "opencode plan",
  ]);
  await expectPinnedUsage(page, summary);
}

async function refreshUsageAndWaitForReports(page: Page, usage: UsageReportsFixture) {
  const requestCount = usage.listRequests().length;
  await refreshAllUsage(page);
  await usage.waitForListRequests(requestCount + 1);
  const group = page.getByTestId(`usage-host-${getServerId()}`);
  await expect(group.getByText("41% used", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh all", exact: true })).toBeEnabled();
}

test.describe("usage modal", () => {
  test("opens from the sidebar on the host's reports, with no host named for one host", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          {
            id: "alpha:a",
            account: {},
            fetchedAt: twoHoursAgo(),
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: {
              status: "available",
              windows: [{ id: "weekly", label: "Weekly", usedPct: 31 }],
            },
          },
          {
            id: "beta:b",
            account: {},
            fetchedAt: "2026-01-01T00:00:00.000Z",
            sourceId: "beta",
            sourceLabel: "Beta plan",
            report: {
              status: "unavailable",
              problem: { kind: "no_quota", detail: "No active coding plan" },
            },
          },
        ],
      ],
    });

    await gotoAppShell(page);
    await openUsageFromItem(page);
    await usage.waitForListRequests(1);

    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("Alpha plan", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("usage-modal-host")).toHaveCount(0);
    await qaScreenshot(page, "usage-modal-one-host");
    await expect(group.getByText("31% used")).toBeVisible();
    await expect(group.getByText("Beta plan", { exact: true })).toBeVisible();
    await expect(group.getByText("Unavailable", { exact: true })).toBeVisible();

    await group.getByTestId("usage-refresh").first().hover();
    await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated 2h ago");
    await expect(group.getByTestId("usage-freshness")).toHaveCount(0);
  });

  for (const width of [1440, 390]) {
    test(`keeps sidebar and modal provider order across a reversed refresh at width ${width}`, async ({
      page,
    }) => {
      const usage = await installReversedUsageRefresh(page);
      await openUsageSummaryAtWidth(page, width);
      // Reports arrive opencode first; cards and the summary stay alphabetical.
      await expectUsageProviderOrder(page, ["12% Weekly", "31% Weekly"]);
      await qaScreenshot(page, `usage-order-${width}-before-refresh`);

      await refreshUsageAndWaitForReports(page, usage);
      await expectUsageProviderOrder(page, ["22% Weekly", "41% Weekly"]);
      await qaScreenshot(page, `usage-order-${width}-after-refresh`);
    });
  }

  test("keeps a card turned off and a dragged order after a reload", async ({ page }) => {
    test.setTimeout(120_000);
    await installUsageReportsFixture(page, {
      lists: [
        [
          accountReport("beta", "work", 12),
          weeklyReport("alpha", 31),
          accountReport("beta", "home", 20),
        ],
      ],
    });
    await gotoAppShell(page);
    // Three Weekly labels overflow the summary, so it falls back to compact shorthands.
    await expectPinnedUsage(page, ["31% wk", "20% wk", "12% wk"]);
    await openUsageFromItem(page);
    await expectUsageCardOrder(page, ["alpha:a", "beta:home", "beta:work"]);

    // Without the pointer over the card, keyboard focus on its handle shows the handle.
    await page.mouse.move(0, 0);
    const alphaHandle = page
      .getByTestId("usage-report-alpha:a")
      .getByRole("button", { name: "Reorder alpha plan", exact: true });
    await expect(alphaHandle).toHaveCSS("opacity", "0");
    await alphaHandle.focus();
    await expect(alphaHandle).toHaveCSS("opacity", "1");
    await alphaHandle.blur();

    // Turning a source off in the dedicated Sources list removes its card and sidebar summary.
    await setUsageCardOn(page, "beta:work", false);
    await expectUsageCardOrder(page, ["alpha:a", "beta:home"]);
    await expect(page.getByTestId("usage-report-beta:work")).toHaveCount(0);
    await expectPinnedUsage(page, ["31% Weekly", "20% Weekly"]);

    const stopRecording = await recordUsageCardPositionsAfterRelease(page);
    await dragUsageCardAbove(page, "beta:home", "alpha:a");
    await expectUsageCardOrder(page, ["beta:home", "alpha:a"]);
    await expectPinnedUsage(page, ["20% Weekly", "31% Weekly"]);
    // The cards are in their new slots from the first frame after the drop.
    const framesAfterDrop = await stopRecording();
    const settled = framesAfterDrop.at(-1);
    expect(settled).toBeDefined();
    expect(framesAfterDrop.filter((frame) => frame !== settled)).toEqual([]);

    await page.reload();
    await expectPinnedUsage(page, ["20% Weekly", "31% Weekly"]);
    await openUsageFromItem(page);
    await expectUsageCardOrder(page, ["beta:home", "alpha:a"]);
    await expect(page.getByTestId("usage-report-beta:work")).toHaveCount(0);
  });

  for (const [size, viewport] of Object.entries({
    desktop: { width: 1440, height: 900 },
    compact: { width: 390, height: 844 },
  })) {
    test(`dedicated Sources list manages default-off sources without clutter (${size})`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const [claude, codex] = claudeAndCodexReports();
      const fetchedAt = twoHoursAgo();
      await installUsageReportsFixture(page, {
        lists: [
          () => [
            claude!,
            codex!,
            {
              id: "copilot:default",
              account: {},
              fetchedAt,
              sourceId: "copilot",
              sourceLabel: "GitHub Copilot",
              defaultEnabled: false,
              report: {
                status: "unavailable",
                problem: { kind: "rejected", status: 403 },
              },
            },
            {
              id: "cursor:default",
              account: { label: "dev@example.com" },
              fetchedAt,
              sourceId: "cursor",
              sourceLabel: "Cursor",
              defaultEnabled: false,
              report: {
                status: "available",
                windows: [
                  { id: "monthly", label: "Monthly", shortLabel: "mo", summary: true, usedPct: 18 },
                ],
              },
            },
          ],
        ],
      });
      await page.setViewportSize(viewport);
      await gotoAppShell(page);
      if (size === "compact") await openCompactSidebar(page);
      // Only active sources appear in the sidebar summary and modal cards.
      await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
      await openUsageFromItem(page);
      await expectUsageCardOrder(page, ["claude:default", "codex:default"]);
      await expect(page.getByTestId("usage-report-copilot:default")).toHaveCount(0);
      await expect(page.getByTestId("usage-report-cursor:default")).toHaveCount(0);
      await qaScreenshot(page, `usage-sources-${size}-cards`);

      await openUsageOptions(page);
      await expect(page.getByTestId("usage-options-sources")).toContainText("2 of 4");
      await qaScreenshot(page, `usage-sources-${size}-settings`);

      if (size === "compact") {
        // Compact sheets expose menu rows in the browser Tab order so keyboard users can open
        // Sources and toggle checkboxes without a pointer.
        await page.getByTestId("usage-options-sources").focus();
        await expect(page.getByTestId("usage-options-sources")).toBeFocused();
        await expect(page.getByTestId("usage-options-sources")).toHaveAttribute("tabindex", "0");
        await page.keyboard.press("Enter");
      } else {
        await openUsageSources(page);
      }
      const claudeToggle = page.getByRole("checkbox", { name: /^Claude/ });
      const copilotToggle = page.getByRole("checkbox", { name: /^GitHub Copilot/ });
      const cursorToggle = page.getByRole("checkbox", { name: /^Cursor/ });
      await expect(claudeToggle).toBeChecked();
      await expect(copilotToggle).not.toBeChecked();
      await expect(copilotToggle).toContainText("Provider inactive");
      await qaScreenshot(page, `usage-sources-${size}-list`);

      // Opting into a default-off source brings its card and summary window in immediately.
      if (size === "compact") {
        await cursorToggle.focus();
        await expect(cursorToggle).toBeFocused();
        await expect(cursorToggle).toHaveAttribute("tabindex", "0");
        await page.keyboard.press("Space");
      } else {
        await cursorToggle.click();
      }
      await expect(cursorToggle).toBeChecked();
      await closeUsageOptions(page);
      await expectUsageCardOrder(page, ["claude:default", "codex:default", "cursor:default"]);

      // Hiding every source shows a quiet empty state with a shortcut back to Settings.
      await openUsageSources(page);
      await page.getByTestId("usage-source-toggle-claude:default").click();
      await page.getByTestId("usage-source-toggle-codex:default").click();
      await page.getByTestId("usage-source-toggle-cursor:default").click();
      await closeUsageOptions(page);
      await expect(page.getByTestId("usage-all-hidden")).toBeVisible();
      await expect(page.getByTestId("usage-choose-sources")).toBeVisible();
      await qaScreenshot(page, `usage-sources-${size}-empty`);
      await page.getByTestId("usage-choose-sources").click();
      await expect(page.getByTestId("usage-options-sources")).toContainText("0 of 4");
    });
  }

  test("refreshes one report from its card", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const beta: UsageReportEntry = {
      id: "beta:b",
      account: {},
      fetchedAt: twoHoursAgo(),
      sourceId: "beta",
      sourceLabel: "Beta plan",
      report: {
        status: "available",
        windows: [{ id: "weekly", label: "Weekly", usedPct: 12 }],
      },
    };
    const alpha = (usedPct: number, fetchedAt: string): UsageReportEntry => ({
      id: "alpha:a",
      account: {},
      fetchedAt,
      sourceId: "alpha",
      sourceLabel: "Alpha plan",
      report: {
        status: "available",
        windows: [{ id: "weekly", label: "Weekly", usedPct }],
      },
    });
    // The sidebar summary and the modal each load reports; only a card's Refresh forces one.
    const usage = await installUsageReportsFixture(page, {
      lists: [
        (request) =>
          request.forceRefresh
            ? [alpha(58, new Date().toISOString())]
            : [alpha(31, twoHoursAgo()), beta],
      ],
    });

    await gotoAppShell(page);
    await openUsageFromItem(page);
    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("31% used")).toBeVisible({ timeout: 10_000 });

    const alphaRefresh = group.getByTestId("usage-refresh").first();
    await alphaRefresh.click();
    await expect
      .poll(() => forcedRefreshes(usage))
      .toEqual([{ forceRefresh: true, reportIds: ["alpha:a"] }]);
    await expect(group.getByText("58% used")).toBeVisible();
    await expect(group.getByText("12% used")).toBeVisible();

    await group.getByTestId("usage-refresh").nth(1).hover();
    await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated 2h ago");
    await alphaRefresh.hover();
    await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated just now");
  });

  test("shows the host once it connects after a cold load on a phone", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          {
            id: "alpha:a",
            account: {},
            fetchedAt: twoHoursAgo(),
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: { status: "available", windows: [] },
          },
        ],
      ],
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoAppShell(page);
    await openCompactSidebar(page);
    await openUsageFromIcon(page);
    await usage.waitForListRequests(1);

    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("Alpha plan", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(group.getByTestId("usage-freshness")).toHaveText("Updated 2h ago");
  });

  test("tells the user to update a host without usage support", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, { usageSupported: false });

    await gotoAppShell(page);
    // Without reports the footer has no Usage item; its Usage icon opens Usage.
    await openUsageFromIcon(page);

    await expect(
      page.getByTestId(`usage-host-${serverId}`).getByText(/^Update .+ to see usage$/),
    ).toBeVisible({ timeout: 10_000 });
    await qaScreenshot(page, "phase7-usage-update-host");
    await expect(page.getByTestId("usage-options-menu")).toHaveCount(0);
    await expect(page.getByTestId("usage-refresh-all")).toHaveCount(0);
    expect(usage.listRequests()).toHaveLength(0);
  });

  test("a host picked in the Usage modal is the sidebar's host too, after a reload", async ({
    page,
  }) => {
    test.setTimeout(420_000);
    const primaryServerId = getServerId();
    const secondary = await startIsolatedHostDaemon(
      `srv_usage_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    try {
      await installUsageReportsFixture(page, { lists: [[weeklyReport("alpha", 31)]] });
      // The second host's reports wait until the test lets them through, like a slow host.
      const secondaryReports = gate();
      await installUsageReportsFixture(page, {
        port: secondary.port,
        lists: [{ stream: [secondaryReports.promise, weeklyReport("beta", 12)] }],
      });
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondary.serverId,
        label: "Secondary box",
        port: secondary.port,
      });

      // Nothing picked and no workspace open: the first host.
      await expectPinnedUsage(page, ["31% Weekly"]);
      await openUsageFromItem(page);
      await expect(page.getByTestId(`usage-host-${primaryServerId}`)).toBeVisible();

      await expect(usageModalHost(page)).toHaveText("localhost");
      await pickUsageHost(page, secondary.serverId);
      // Until its reports arrive, the picked host loads; it never shows the first host's cards.
      const secondaryBody = page.getByTestId(`usage-host-${secondary.serverId}`);
      await expect(secondaryBody.getByText("Loading usage...")).toBeVisible();
      await expect(page.getByTestId("usage-modal-body").getByText("31% used")).toHaveCount(0);
      await expect(usageModalHost(page)).toHaveText("Secondary box");
      secondaryReports.open();
      await expect(secondaryBody.getByText("12% used")).toBeVisible({ timeout: 30_000 });
      await qaScreenshot(page, "usage-modal-picked-host");
      await expectPinnedUsage(page, ["12% Weekly"]);

      // The e2e seed resets the host list on every load, so reopening re-adds the second host.
      await addConnectedHostAndReload(page, {
        serverId: secondary.serverId,
        label: "Secondary box",
        port: secondary.port,
      });
      await expectPinnedUsage(page, ["12% Weekly"]);
      await openUsageFromItem(page);
      await expect(
        page.getByTestId(`usage-host-${secondary.serverId}`).getByText("12% used"),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await secondary.close().catch(() => undefined);
    }
  });

  test("on a phone, picking a host in Settings keeps Usage open on that host", async ({ page }) => {
    test.setTimeout(420_000);
    const longName = "build-box-eu-west-gpu-runner-02.internal";
    const secondary = await startIsolatedHostDaemon(
      `srv_usage_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    try {
      await installUsageReportsFixture(page, { lists: [[weeklyReport("alpha", 31)]] });
      await installUsageReportsFixture(page, {
        port: secondary.port,
        lists: [[weeklyReport("beta", 12)]],
      });
      await page.setViewportSize({ width: 375, height: 812 });
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondary.serverId,
        label: longName,
        port: secondary.port,
      });
      await openCompactSidebar(page);
      await openUsageFromItem(page);

      await pickUsageHost(page, secondary.serverId);

      // The sheet stays up once Settings has closed over it, showing the picked host's cards.
      await expect(
        page.getByTestId(`usage-host-${secondary.serverId}`).getByText("12% used"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(usageModalHost(page)).toHaveText(longName);
      // The long name truncates under the title; the title itself reads in full.
      const title = page.locator('[data-testid="usage-modal-title"]:visible');
      await expect(title).toHaveText("Usage");
      expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      const host = usageModalHost(page);
      expect(await host.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
      await qaScreenshot(page, "usage-phone-picked-long-host");
    } finally {
      await secondary.close().catch(() => undefined);
    }
  });
});

const loginWindows: UsageReportEntry["report"] = {
  status: "available",
  windows: [
    { id: "five_hour", label: "Session", shortLabel: "5h", summary: true, usedPct: 31 },
    { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, usedPct: 54 },
  ],
};

test("expired login refreshes to windows with visible pin toggles", async ({ page }) => {
  const fixture = await installLoginUsage({
    status: "unavailable",
    problem: {
      kind: "expired",
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      refreshedBy: "claude",
    },
  });
  try {
    await gotoAppShell(page);
    await openUsageFromIcon(page);
    await expect(
      page.getByText("Claude: Login expired 1h ago. Run claude to refresh it.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
    await qaScreenshot(page, "usage-expired-login");
    await fixture.setReport(loginWindows);
    await refreshLoginUsage(page);
    await expect(
      page.getByText("Claude: Login expired 1h ago. Run claude to refresh it.", { exact: true }),
    ).toHaveCount(0);
    await expectPinnedUsage(page, ["31% 5h", "54% wk"]);
    const row = page.getByRole("checkbox", { name: /^Pin Claude Weekly, / });
    await expect(row).toBeChecked();
    await expect(row.getByTestId("usage-pin-glyph-pinned")).toHaveCSS("opacity", "1");
    await hoverUsageWindow(page, "Weekly");
    await expect(page.getByText("Unpin", { exact: true })).toBeVisible();
    await expect(row.getByTestId("usage-pin-glyph-pinned")).toHaveCSS("opacity", "1");
    await expect(row.getByTestId("usage-pin-glyph-pinned").locator("svg")).not.toHaveAttribute(
      "fill",
      "none",
    );
    await qaScreenshot(page, "usage-pin-hover");
    await togglePin(page.getByTestId("usage-report-login-journey:account"), "Claude", "Weekly");
    await expect(row.getByTestId("usage-pin-glyph-unpinned")).toHaveCSS("opacity", "1");
    await expect(row.getByTestId("usage-pin-glyph-unpinned").locator("svg")).toHaveAttribute(
      "fill",
      "none",
    );
    await hoverUsageWindow(page, "Weekly");
    await expect(page.getByText("Pin", { exact: true })).toBeVisible();
    await expectPinnedUsage(page, ["31% 5h"]);
    await qaScreenshot(page, "usage-pin-unselected");
    await togglePin(page.getByTestId("usage-report-login-journey:account"), "Claude", "Weekly");
    await expect(row.getByTestId("usage-pin-glyph-pinned")).toHaveCSS("opacity", "1");
    await expectPinnedUsage(page, ["31% 5h", "54% wk"]);
  } finally {
    await fixture.cleanup();
  }
});

test("compact usage rows always show the pin glyph", async ({ page }) => {
  const fixture = await installLoginUsage(loginWindows);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoAppShell(page);
    await openCompactSidebar(page);
    await openUsageFromIcon(page);
    const card = page.getByTestId("usage-report-login-journey:account");
    await expect(card.getByTestId("usage-pin-glyph-pinned")).toHaveCount(2);
    await expect(card.getByTestId("usage-pin-glyph-pinned").nth(0)).toHaveCSS("opacity", "1");
    await expect(card.getByTestId("usage-pin-glyph-pinned").nth(1)).toHaveCSS("opacity", "1");
    await qaScreenshot(page, "usage-pin-compact");
  } finally {
    await fixture.cleanup();
  }
});

for (const shape of ["seven-day-only", "Spark"] as const) {
  test(`Codex ${shape} windows use provider durations on the card and sidebar`, async ({
    page,
  }) => {
    const reset = Math.floor(Date.now() / 1000) + 5 * 86400;
    const source = await installCodexWindowUsage({
      rate_limit: {
        primary_window: { used_percent: 11, limit_window_seconds: 604800, reset_at: reset },
        secondary_window: null,
      },
      additional_rate_limits:
        shape === "Spark"
          ? [
              {
                limit_name: "GPT-5.3-Codex-Spark",
                metered_feature: "codex_bengalfox",
                rate_limit: {
                  primary_window: {
                    used_percent: 0,
                    limit_window_seconds: 18000,
                    reset_at: Math.floor(Date.now() / 1000) + 3600,
                  },
                  secondary_window: {
                    used_percent: 0,
                    limit_window_seconds: 604800,
                    reset_at: reset,
                  },
                },
              },
            ]
          : [],
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoAppShell(page);
      await expect(usageItem(page)).toBeVisible();
      await openUsageFromItem(page);
      await qaScreenshot(page, `codex-${shape}-card-and-summary`);
      await expectCodexReportedWindows(page, shape);
      await qaScreenshot(page, `codex-${shape}-pins`);
    } finally {
      await source.cleanup();
    }
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const [size, viewport] of Object.entries({
    desktop: { width: 1440, height: 900 },
    compact: { width: 390, height: 844 },
  })) {
    test(`Usage Settings cog ${size} ${theme}`, async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      await page.addInitScript((value) => {
        const key = "@paseo:app-settings";
        const current = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...current, theme: value }));
      }, theme);
      const usage = await installUsageReportsFixture(page, {
        lists: [() => claudeAndCodexReports()],
      });
      await page.setViewportSize(viewport);
      await gotoAppShell(page);
      if (size === "compact") await openCompactSidebar(page);
      await openUsageFromIcon(page);
      const screen = page.getByTestId(`usage-host-${getServerId()}`);
      await expect(screen.getByText("Claude", { exact: true })).toBeVisible({ timeout: 30_000 });
      const settings = page.getByTestId("usage-options-menu");
      await expect(settings).toHaveAccessibleName("Settings");
      await expect(page.getByTestId("usage-display-used")).toHaveCount(0);
      await captureSettingsState(page, testInfo, `${size}-${theme}-cog`);

      await openUsageOptions(page);
      await expectUsageOptionsFitContent(page);
      await expect(page.getByText("Pinned windows show in the sidebar footer")).toBeVisible();
      await expect(page.getByTestId("usage-display-used")).toHaveAttribute("aria-selected", "true");
      await captureSettingsState(page, testInfo, `${size}-${theme}-settings`);
      await showUsageAs(page, "remaining");
      await expect(screen.getByText("69% left")).toBeVisible();
      await showUsageAs(page, "used");
      await expect(pinRow(screen, "Claude", "Session")).toHaveAccessibleName(
        /^Pin Claude Session, 31% used · resets /,
      );
      await openUsageOptions(page);
      await closeUsageOptions(page);
      await refreshAllUsage(page);
      await expect.poll(() => forcedRefreshes(usage)).toEqual([{ forceRefresh: true }]);
    });
  }
}

async function captureSettingsState(
  page: Page,
  testInfo: import("@playwright/test").TestInfo,
  name: string,
) {
  await qaScreenshot(page, name);
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

test("an account with all logins failing shows each harness and remedy, then only usage when one succeeds", async ({
  page,
}) => {
  const fixture = await installLoginUsage([
    { harness: "Codex", report: { status: "error", error: "Usage API returned 500. Try again." } },
    {
      harness: "OpenCode",
      report: {
        status: "unavailable",
        problem: { kind: "rejected", status: 401, refreshedBy: "opencode" },
      },
    },
    {
      harness: "Pi",
      report: { status: "unavailable", problem: { kind: "no_quota", detail: "No active plan" } },
    },
    {
      harness: "OMP",
      report: {
        status: "unavailable",
        problem: { kind: "rejected", status: 403, refreshedBy: "omp" },
      },
    },
  ]);
  try {
    await gotoAppShell(page);
    await openUsageFromIcon(page);
    await expectLoginErrors(page, [
      "Codex: Usage API returned 500. Try again.",
      "OpenCode: Login rejected (HTTP 401). Run opencode to refresh it.",
      "Pi: No active plan",
      "OMP: Login rejected (HTTP 403). Run omp to refresh it.",
    ]);
    await fixture.setReport([
      {
        harness: "Codex",
        report: { status: "error", error: "Usage API returned 500. Try again." },
      },
      {
        harness: "OpenCode",
        report: { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 42 }] },
      },
    ]);
    await refreshLoginUsage(page);
    await expectLoginUsageOnly(page, "42% used");
  } finally {
    await fixture.cleanup();
  }
});

async function expectLoginErrors(page: Page, lines: string[]) {
  const card = page.getByTestId("usage-report-login-journey:account");
  await expect(card.getByTestId("usage-login-error")).toHaveText(lines.join("\n"));
}

async function expectLoginUsageOnly(page: Page, percentage: string) {
  const card = page.getByTestId("usage-report-login-journey:account");
  await expect(card.getByText(new RegExp(`^${percentage}(?:$| ·)`))).toBeVisible();
  await expect(card.getByTestId("usage-login-error")).toHaveCount(0);
}

for (const compact of [false, true]) {
  test(`failed polls retain usage and successful freshness (${compact ? "footer" : "tooltip"})`, async ({
    page,
  }) => {
    const fixture = await installLoginUsage({ status: "error", error: "Initial failure" });
    try {
      await page.clock.install();
      await page.setViewportSize(
        compact ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      );
      await gotoAppShell(page);
      if (compact) await openCompactSidebar(page);
      await openUsageFromIcon(page);
      await expectLoginErrors(page, ["Claude: Initial failure"]);
      await test.step("developer errors do not interrupt freshness inspection", async () => {
        await page.evaluate(() => console.error("E2E: developer toast while Usage is open"));
        await expectLoginUsageFreshness(page, "No successful update", compact);
      });

      await fixture.setReport({
        status: "available",
        windows: [{ id: "weekly", label: "Weekly", usedPct: 42, resetsAt: "2000-01-01T00:00:00Z" }],
      });
      // Move only the browser clock; real daemon fetches continue using the host clock.
      await page.clock.setFixedTime(new Date(Date.now() + 3_900_000));
      await refreshLoginUsage(page);
      await expectLoginUsageOnly(page, "42% used");
      await advanceUsageClock(page, 60_000);
      await expectLoginUsageFreshness(page, "Updated 1h ago", compact);

      await fixture.setReport({ status: "error", error: "Rate limited" });
      await refreshLoginUsage(page);
      await expectRetainedLoginUsage(page, "Claude: Rate limited");
      await expectLoginUsageFreshness(page, "Last updated 1h ago", compact);
      await expectPinnedUsage(page, ["42% Weekly"]);
      await expect(usageItem(page).getByTestId("sidebar-usage-error")).toBeVisible();
      await expect(usageItem(page)).toHaveAccessibleName(/Unable to refresh usage/);
      await qaScreenshot(page, `usage-error-detail-${compact ? "compact" : "desktop"}`);
      await closeUsage(page);
      await qaScreenshot(page, `usage-error-summary-${compact ? "compact" : "desktop"}`, "summary");
      await openUsageFromItem(page);
      await expectRetainedLoginUsage(page, "Claude: Rate limited");

      await refreshLoginUsage(page);
      await expectRetainedLoginUsage(page, "Claude: Rate limited");
      await expectLoginUsageFreshness(page, "Last updated 1h ago", compact);

      await fixture.setReport({
        status: "unavailable",
        problem: { kind: "no_quota", detail: "No active quota" },
      });
      await refreshLoginUsage(page);
      await expectRetainedLoginUsage(page, "Claude: No active quota");
      await expectLoginUsageFreshness(page, "Last updated 1h ago", compact);
      await expectPinnedUsage(page, ["42% Weekly"]);
      await expect(usageItem(page).getByTestId("sidebar-usage-error")).toHaveCount(0);

      await fixture.setReport({
        status: "available",
        windows: [{ id: "weekly", label: "Weekly", usedPct: 43 }],
      });
      await page.clock.setFixedTime(new Date(Date.now() + 150_000));
      await refreshLoginUsage(page);
      await expectLoginUsageOnly(page, "43% used");
      await expectPinnedUsage(page, ["43% Weekly"]);
      await expect(usageItem(page).getByTestId("sidebar-usage-error")).toHaveCount(0);
      await expect(usageItem(page)).not.toHaveAccessibleName(/Unable to refresh usage/);
      await advanceUsageClock(page, 60_000);
      await expect(page.getByText("42% used", { exact: true })).toHaveCount(0);
      await expectLoginUsageFreshness(page, "Updated 2m ago", compact);
    } finally {
      await fixture.cleanup();
    }
  });
}

async function expectRetainedLoginUsage(page: Page, message: string) {
  const card = page.getByTestId("usage-report-login-journey:account");
  await expect(card.getByText(/^42% used(?:$| ·)/)).toBeVisible();
  await expect(card.getByTestId("usage-login-error")).toHaveText(message);
  await expect(card.getByText("Reset time passed", { exact: false })).toBeVisible();
}

async function switchToJapanese(page: Page) {
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openSettings(page);
  await openSettingsSection(page, "general");
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem", { name: "日本語 - Japanese", exact: true }).click();
  await page.getByRole("button", { name: "戻る", exact: true }).click();
}

async function openJapaneseUsage(page: Page) {
  await page.getByRole("button", { name: "使用状況", exact: true }).click();
  await expect(page.getByTestId("usage-modal").first()).toBeVisible();
}

test("usage percentages state their meaning and follow the selected language", async ({ page }) => {
  test.setTimeout(120_000);
  const login = await installLoginUsage({
    status: "available",
    windows: [{ id: "session", label: "Session", usedPct: 70, summary: true }],
  });
  try {
    await gotoAppShell(page);
    await openUsageFromIcon(page);
    await expect(page.getByText("70% used", { exact: true })).toBeVisible();
    await switchToJapanese(page);
    await expect(usageItem(page)).toHaveAccessibleName(/Claude セッション 70% 使用済み/);
    await openJapaneseUsage(page);
    await expect(page.getByText("70% 使用済み", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "すべて更新", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "設定", exact: true }).last().click();
    await expect(page.getByText("割合", { exact: true })).toBeVisible();
    await expect(page.getByText("使用済み", { exact: true })).toBeVisible();
    await expect(page.getByText("残り", { exact: true })).toBeVisible();
  } finally {
    await login.cleanup();
  }
});

const exhaustionClock = /^runs out (?:[A-Z][a-z]{2} )?\d{1,2}:\d{2}(?: [AP]M)?$/;

test("open usage clocks advance without refreshing or reopening", async ({ page }) => {
  test.setTimeout(120_000);
  const now = new Date();
  const reset = new Date(now.getTime() + 30.5 * 60_000).toISOString();
  const login = await installLoginUsage({
    status: "available",
    windows: [
      { id: "session", label: "Session", usedPct: 42, resetsAt: reset },
      { id: "weekly", label: "Weekly", usedPct: 80, runsOutAt: reset, shortfallPct: 10 },
    ],
    balances: [{ id: "credits", label: "Credits", unit: "usd", remaining: 12, resetsAt: reset }],
  });
  try {
    await openCompactUsageWithClock(page, now);
    const card = page.getByTestId("usage-report-login-journey:account");
    await expect(card.getByTestId("usage-freshness")).toHaveText("Updated just now");
    await expect(card.getByText("resets in 30m", { exact: false }).first()).toBeVisible();
    const forecast = card.getByText(exhaustionClock);
    await expect(forecast).toBeVisible();
    const forecastTime = (await forecast.innerText()).replace(/^[^0-9]+/, "");
    // The shared minute clock is wall-aligned, and the daemon timestamps use real time.
    // After two browser minutes the latest displayed tick is one or two minutes old.
    await advanceUsageClock(page, 120_000);
    await expect(card.getByTestId("usage-freshness")).toHaveText(/^Updated [12]m ago$/);
    await expect(card.getByText(/resets in (28|29)m/).first()).toBeVisible();
    // The weekday drops off at local midnight, but the forecast time stays fixed.
    await expect(forecast).toHaveText(new RegExp(` ${forecastTime}$`));
    await expect(card.getByTestId("provider-usage-balance-credits-reset")).toHaveText(
      /^resets in (28|29)m\s·\s/,
    );
  } finally {
    await login.cleanup();
  }
});

test("Refresh all keeps quota visible after a timeout and shows only reset details when back on track", async ({
  page,
}) => {
  const reading = new Date();
  const login = await installLoginUsage(usageReading(reading, 40));
  try {
    const transport = await installDaemonWebSocketGate(page);
    await openCompactUsageWithClock(page, reading);
    await expectQuota(page, "40% used", exhaustionClock);

    await timeOutUsageRefresh(page, transport);
    await expectQuota(page, "40% used", null);
    await expectUsageRefreshError(page).toBeVisible();

    await login.setReport(usageReading(reading, 10));
    transport.releaseHeldClientRequest();
    await refreshAllUsage(page);
    await expectQuota(page, "10% used", null);
    await expectUsageRefreshError(page).toBeHidden();
  } finally {
    await login.cleanup();
  }
});

test("a card refresh timeout is visible alongside a newer quota forecast", async ({ page }) => {
  const reading = new Date();
  const login = await installLoginUsage(usageReading(reading, 40));
  try {
    const transport = await installDaemonWebSocketGate(page);
    await openCompactUsageWithClock(page, reading);
    await expectQuota(page, "40% used", exhaustionClock);

    await delayCardRefreshResponse(page, transport);
    await login.setReport(usageReading(reading, 45));
    await refreshAllUsage(page);
    await expectQuota(page, "45% used", exhaustionClock);

    await advanceUsageClock(page, 61_000);
    await expect(
      usageModal(page)
        .getByTestId("usage-report-login-journey:account")
        .getByTestId("usage-refresh-error"),
    ).toHaveText("Unable to refresh usage");
    await expectQuota(page, "45% used", exhaustionClock);
  } finally {
    await login.cleanup();
  }
});

function expectUsageRefreshError(page: Page) {
  return expect(
    usageModal(page).getByRole("alert").getByText("Unable to refresh usage", { exact: true }),
  );
}

async function delayCardRefreshResponse(
  page: Page,
  transport: Awaited<ReturnType<typeof installDaemonWebSocketGate>>,
) {
  await expect(page.getByRole("button", { name: "Refresh all", exact: true })).toBeEnabled();
  transport.holdNextServerMessage("usage.list_reports.response");
  await refreshLoginUsage(page);
  await transport.waitForHeldServerMessage("usage.list_reports.response");
}

function usageReading(observed: Date, usedPct: number): UsageReport {
  return {
    status: "available",
    observedAt: observed.toISOString(),
    windows: [
      {
        id: "session",
        label: "Session",
        usedPct,
        durationSeconds: 18_000,
        resetsAt: new Date(observed.getTime() + 4 * 3_600_000).toISOString(),
      },
    ],
  };
}

async function expectQuota(page: Page, amount: string, forecast: string | RegExp | null) {
  const usage = usageModal(page);
  await expect(usage.getByText(amount, { exact: true })).toBeVisible();
  await expect(usage.getByText(/^resets in /)).toBeVisible();
  if (forecast === null) {
    await expect(usage.getByRole("checkbox", { name: /^Pin Claude Session/ })).toHaveAccessibleName(
      /^Pin Claude Session, \d+% used · resets in [^·]+ · [^·]+$/,
    );
    await expect(usage.getByText(/^runs out /)).toBeHidden();
    return;
  }
  await expect(usage.getByText(forecast)).toBeVisible();
}

async function timeOutUsageRefresh(
  page: Page,
  transport: Awaited<ReturnType<typeof installDaemonWebSocketGate>>,
) {
  const refresh = page.getByRole("button", { name: "Refresh all", exact: true });
  await expect(refresh).toBeEnabled();
  transport.holdNextClientRequest("usage.list_reports.request");
  await refreshAllUsage(page);
  await transport.waitForHeldClientRequest();
  await expect(refresh).toBeDisabled();
  await advanceUsageClock(page, 61_000);
  await expect(refresh).toBeEnabled();
}

async function openCompactUsageWithClock(page: Page, now: Date) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: now });
  await gotoAppShell(page);
  await openCompactSidebar(page);
  await openUsageFromIcon(page);
}

async function advanceUsageClock(page: Page, milliseconds: number) {
  await page.clock.fastForward(milliseconds);
}
