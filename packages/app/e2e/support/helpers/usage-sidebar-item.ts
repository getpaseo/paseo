import { readFileSync } from "node:fs";
import path from "node:path";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, type Locator, type Page } from "@playwright/test";

const PLUGINS_DIR = path.resolve(__dirname, "../../../../../plugins");

function sourceIcon(plugin: string): string {
  return readFileSync(path.join(PLUGINS_DIR, plugin, "icon.svg"), "utf8");
}

function inOneDay(): string {
  return new Date(Date.now() + 24 * 60 * 60_000).toISOString();
}

/** Claude and Codex reports shaped like the built-in sources report them. */
export function claudeAndCodexReports(): UsageReportEntry[] {
  const fetchedAt = new Date().toISOString();
  return [
    {
      id: "claude:default",
      account: { label: "dev@example.com" },
      fetchedAt,
      sourceId: "claude",
      sourceLabel: "Claude",
      icon: sourceIcon("claude-usage-source"),
      report: {
        status: "available",
        planLabel: "Max",
        windows: [
          {
            id: "five_hour",
            label: "Session",
            shortLabel: "5h",
            summary: true,
            usedPct: 31,
            resetsAt: inOneDay(),
          },
          {
            id: "weekly",
            label: "Weekly",
            shortLabel: "wk",
            summary: true,
            usedPct: 54,
            resetsAt: inOneDay(),
          },
        ],
      },
    },
    {
      id: "codex:default",
      account: { label: "dev@example.com" },
      fetchedAt,
      sourceId: "codex",
      sourceLabel: "Codex",
      icon: sourceIcon("codex-usage-source"),
      report: {
        status: "available",
        planLabel: "Pro",
        windows: [
          {
            id: "session",
            label: "Session",
            shortLabel: "5h",
            summary: true,
            usedPct: 7,
            resetsAt: inOneDay(),
          },
          {
            id: "weekly",
            label: "Weekly",
            shortLabel: "wk",
            summary: true,
            usedPct: 12,
            resetsAt: inOneDay(),
          },
        ],
      },
    },
  ];
}

/** The first visible match: the shell keeps a compact copy of the sidebar mounted. */
function visible(page: Page, testID: string): Locator {
  return page.locator(`[data-testid="${testID}"]:visible`).first();
}

/** The sidebar footer's Usage item: pinned windows, or a plain "Usage" row without any. */
export function usageItem(page: Page): Locator {
  return visible(page, "sidebar-usage");
}

/** The compact usage sheet the Usage item opens. */
export function usageSheet(page: Page): Locator {
  return visible(page, "usage-expanded");
}

export async function expectOnUsageScreen(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/usage$/);
}

/** Each pinned window as it reads: its percent and short label, "31% 5h". */
export async function expectPinnedUsage(page: Page, windows: string[]): Promise<void> {
  const pinned = usageItem(page).getByTestId("sidebar-usage-pinned-window");
  await expect(pinned).toHaveText(windows);
}

/** Without pinned windows the Usage item is a plain row that reads "Usage". */
export async function expectNoPinnedUsage(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="sidebar-usage-pinned-window"]:visible')).toHaveCount(0);
  await expect(usageItem(page)).toHaveText("Usage");
}

/** A window row, which is itself the pin toggle: "Claude", "Session". */
export function pinRow(scope: Locator, source: string, window: string): Locator {
  // The row's label goes on with its percent and reset: "Pin Claude Session, 31% · resets in 2h".
  return scope.getByRole("checkbox", { name: new RegExp(`^Pin ${source} ${window}, `) });
}

export async function togglePin(scope: Locator, source: string, window: string) {
  const row = pinRow(scope, source, window);
  const pinned = await row.isChecked();
  await row.click();
  await expect(row).toBeChecked({ checked: !pinned });
}

/** The usage title row's options menu: Refresh and Used/Remaining. */
export async function openUsageOptions(page: Page): Promise<void> {
  await page.locator('[data-testid="usage-options-menu"]:visible').first().click();
  await expect(page.getByTestId("usage-display-used")).toBeVisible();
}

export async function showUsageAs(page: Page, displayAs: "used" | "remaining") {
  await openUsageOptions(page);
  await page.getByTestId(`usage-display-${displayAs}`).click();
  await expect(page.getByTestId("usage-display-used")).toHaveCount(0);
}

export async function refreshAllUsage(page: Page): Promise<void> {
  await openUsageOptions(page);
  await page.getByRole("menuitem", { name: "Refresh", exact: true }).click();
}

/** Opens the compact sidebar drawer. */
export async function openCompactSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
}

/** On a phone the Usage screen has a back header instead of the sidebar menu. */
export async function leaveUsageScreen(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back", exact: true }).first().click();
  await expect(page).not.toHaveURL(/\/usage$/);
}
