import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { getServerId } from "../support/helpers/server-id";
import {
  installUsageReportsFixture,
  type UsageListRequest,
  type UsageReportsFixture,
} from "../support/helpers/usage-reports";
import {
  installLoginUsage,
  installCodexWindowUsage,
  expectCodexReportedWindows,
  openUsage,
  refreshLoginUsage,
  hoverUsageWindow,
} from "../support/helpers/usage-login";
import {
  claudeAndCodexReports,
  expectPinnedUsage,
  pinRow,
  openUsageOptions,
  showUsageAs,
  refreshAllUsage,
  togglePin,
  usageItem,
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

function forcedRefreshes(usage: UsageReportsFixture): UsageListRequest[] {
  return usage.listRequests().filter((request) => request.forceRefresh);
}

// Two hours reads "2h ago" for an hour, so the assertion cannot race the clock.
function twoHoursAgo(): string {
  return new Date(Date.now() - 2 * 60 * 60_000).toISOString();
}

/** Set PASEO_QA_SCREENSHOT_DIR to keep a QA screenshot. */
async function qaScreenshot(page: Page, name: string) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

function hostFilter(page: Page) {
  return page.locator('[data-testid="usage-host-filter-trigger"]:visible');
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

test.describe("usage screen", () => {
  test("opens from the sidebar on the host's reports, with no host filter for one host", async ({
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
    await page.locator('[data-testid="sidebar-usage"]:visible').first().click();
    await expect(page).toHaveURL(/\/usage$/);
    await usage.waitForListRequests(1);

    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("Alpha plan", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(hostFilter(page)).toHaveCount(0);
    await qaScreenshot(page, "phase7-usage-screen-one-host");
    await expect(group.getByText("31%")).toBeVisible();
    await expect(group.getByText("Beta plan", { exact: true })).toBeVisible();
    await expect(group.getByText("Unavailable", { exact: true })).toBeVisible();

    await group.getByTestId("usage-refresh").first().hover();
    await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated 2h ago");
    await expect(group.getByTestId("usage-freshness")).toHaveCount(0);
  });

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
    // The sidebar summary and the screen each load reports; only a card's Refresh forces one.
    const usage = await installUsageReportsFixture(page, {
      lists: [
        (request) =>
          request.forceRefresh
            ? [alpha(58, new Date().toISOString())]
            : [alpha(31, twoHoursAgo()), beta],
      ],
    });

    await gotoAppShell(page);
    await page.locator('[data-testid="sidebar-usage"]:visible').first().click();
    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("31%")).toBeVisible({ timeout: 10_000 });

    const alphaRefresh = group.getByTestId("usage-refresh").first();
    await alphaRefresh.click();
    await expect
      .poll(() => forcedRefreshes(usage))
      .toEqual([{ forceRefresh: true, reportIds: ["alpha:a"] }]);
    await expect(group.getByText("58%")).toBeVisible();
    await expect(group.getByText("12%")).toBeVisible();

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
    await page.goto("/usage");
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
    // Without reports the footer has no Usage item; its Usage icon opens the screen.
    await page.locator('[data-testid="sidebar-usage-icon"]:visible').first().click();

    await expect(
      page.getByTestId(`usage-host-${serverId}`).getByText(/^Update .+ to see usage$/),
    ).toBeVisible({ timeout: 10_000 });
    await qaScreenshot(page, "phase7-usage-update-host");
    await expect(page.getByTestId("usage-options-toggle")).toHaveCount(0);
    await expect(page.getByTestId("usage-refresh-all")).toHaveCount(0);
    expect(usage.listRequests()).toHaveLength(0);
  });

  test("a host picked on the Usage screen is the sidebar's host too, after a reload", async ({
    page,
  }) => {
    test.setTimeout(420_000);
    const primaryServerId = getServerId();
    const secondary = await startIsolatedHostDaemon(
      `srv_usage_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    try {
      await installUsageReportsFixture(page, { lists: [[weeklyReport("alpha", 31)]] });
      await installUsageReportsFixture(page, {
        port: secondary.port,
        lists: [[weeklyReport("beta", 12)]],
      });
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondary.serverId,
        label: "Secondary box",
        port: secondary.port,
      });

      // Nothing picked and no workspace open: the first host.
      await expectPinnedUsage(page, ["31% Weekly"]);
      await usageItem(page).click();
      await expect(page.getByTestId(`usage-host-${primaryServerId}`)).toBeVisible();

      await hostFilter(page).click();
      await page.getByTestId(`usage-host-filter-item-${secondary.serverId}`).click();
      await expect(
        page.getByTestId(`usage-host-${secondary.serverId}`).getByText("12%"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(hostFilter(page)).toContainText("Secondary box");
      await qaScreenshot(page, "usage-screen-picked-host");
      await expectPinnedUsage(page, ["12% Weekly"]);

      // The e2e seed resets the host list on every load, so reopening re-adds the second host.
      await addConnectedHostAndReload(page, {
        serverId: secondary.serverId,
        label: "Secondary box",
        port: secondary.port,
      });
      await expectPinnedUsage(page, ["12% Weekly"]);
      await expect(
        page.getByTestId(`usage-host-${secondary.serverId}`).getByText("12%"),
      ).toBeVisible({ timeout: 30_000 });
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
    await openUsage(page);
    await expect(
      page.getByText("Login expired 1h ago. Run claude to refresh it.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
    await qaScreenshot(page, "usage-expired-login");
    await fixture.setReport(loginWindows);
    await refreshLoginUsage(page);
    await expect(
      page.getByText("Login expired 1h ago. Run claude to refresh it.", { exact: true }),
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
    await openUsage(page);
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
      await usageItem(page).click();
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
    test(`inline Usage Settings ${size} ${theme}`, async ({ page }, testInfo) => {
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
      await page.goto("/usage");
      const screen = page.getByTestId(`usage-host-${getServerId()}`);
      await expect(screen.getByText("Claude", { exact: true })).toBeVisible({ timeout: 30_000 });
      const settings = screen.getByRole("button", { name: "Settings", exact: true });
      const chevron = settings.locator("svg").locator("../..");
      await expect(settings).toHaveAccessibleName("Settings");
      await expect(settings).toHaveAttribute("aria-expanded", "false");
      await expect(chevron).toHaveCSS("transform", "none");
      await expect(screen.getByTestId("usage-display-used")).toHaveCount(0);
      await expect(
        pinRow(screen, "Claude", "Weekly").getByTestId("usage-pin-glyph-pinned"),
      ).toHaveCSS("opacity", "1");
      await captureSettingsState(page, testInfo, `${size}-${theme}-collapsed`);

      await togglePin(screen, "Claude", "Weekly");
      await page.mouse.move(0, viewport.height - 1);
      await expect(
        pinRow(screen, "Claude", "Weekly").getByTestId("usage-pin-glyph-unpinned"),
      ).toHaveCSS("opacity", "1");
      await openUsageOptions(page);
      await expect(settings).toHaveAttribute("aria-expanded", "true");
      await expect(chevron).toHaveCSS("transform", "matrix(0, 1, -1, 0, 0, 0)");
      await expect(screen.getByText("Pinned windows show in the sidebar footer")).toBeVisible();
      await expect(screen.getByTestId("usage-display-used")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await settings.blur();
      await page.mouse.move(0, viewport.height - 1);
      await captureSettingsState(page, testInfo, `${size}-${theme}-expanded`);
      await showUsageAs(page, "remaining");
      await expect(screen.getByText("69% left")).toBeVisible();
      await showUsageAs(page, "used");
      await expect(pinRow(screen, "Claude", "Session")).toHaveAccessibleName(
        /^Pin Claude Session, 31% · resets /,
      );
      await settings.click();
      await expect(settings).toHaveAttribute("aria-expanded", "false");
      await expect(screen.getByTestId("usage-display-used")).toHaveCount(0);
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
