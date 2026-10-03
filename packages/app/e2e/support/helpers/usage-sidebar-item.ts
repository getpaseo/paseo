import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, type Locator, type Page } from "@playwright/test";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";

/** Real usage-source plugin; its long report exercises the sheet's scrolling boundary. */
export async function installTallUsageSource() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-tall-usage-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const cleanup = async () => {
    try {
      await client.removePlugin("tall-usage");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "tall-usage",
        requirements: pluginRequirements,
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import { z } from "zod";
export default function contribute(server) {
  server.registerUsageSource({
    id: "tall-usage", label: "Scrolling account", input: z.object({}),
    discover: async () => [{key: "scrolling-account", input: {}}],
    fetch: async () => ({ status: "available", windows: Array.from({ length: 20 }, (_, i) => ({
      id: String(i), label: "Window " + (i + 1), usedPct: 25,
    })) }),
  });
  return () => {};
}
`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installPluginSource({ source: directory });
    return { cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

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

/** The sidebar footer's Usage item: each summary window with data. */
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

/** Without a summary window with data the footer has no Usage item, only the Usage icon. */
export async function expectNoUsageItem(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="sidebar-usage"]:visible')).toHaveCount(0);
  await expect(page.locator('[data-testid="sidebar-usage-icon"]:visible')).toBeVisible();
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

/** Expand the inline Settings row when its controls are folded. */
export async function openUsageOptions(page: Page): Promise<void> {
  const toggle = visible(page, "usage-options-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(visible(page, "usage-display-used")).toBeVisible();
}

export async function showUsageAs(page: Page, displayAs: "used" | "remaining") {
  await openUsageOptions(page);
  await visible(page, `usage-display-${displayAs}`).click();
  await expect(visible(page, `usage-display-${displayAs}`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

export async function refreshAllUsage(page: Page): Promise<void> {
  await visible(page, "usage-refresh-all").click();
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
