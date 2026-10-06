import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, type Locator, type Page } from "@playwright/test";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";
import { waitForSettledPosition } from "./sheet-layout";

/** Real usage-source plugin; its long report makes the Usage modal scroll. */
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

/** The Usage modal's body: a dialog on wide layouts, a bottom sheet on compact ones. */
export function usageModal(page: Page): Locator {
  return visible(page, "usage-modal-body");
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

/**
 * A report card whose window rows do not pin: no pin toggle, no pin glyph, and nothing focusable
 * but buttons, so no row presses or highlights on hover.
 */
export async function expectUnpinnableRows(card: Locator): Promise<void> {
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card.locator('[data-testid^="usage-pin-"]')).toHaveCount(0);
  const focusable = await card
    .locator("[tabindex]")
    .evaluateAll((nodes) => nodes.filter((node) => node.getAttribute("role") !== "button").length);
  expect(focusable).toBe(0);
}

export async function togglePin(scope: Locator, source: string, window: string) {
  const row = pinRow(scope, source, window);
  const pinned = await row.isChecked();
  await row.click();
  await expect(row).toBeChecked({ checked: !pinned });
}

/**
 * The footer's Usage icon, which is there whether or not the Usage item is on. On a phone the
 * sidebar drawer has to be open.
 */
export async function openUsageFromIcon(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Usage", exact: true }).click({ timeout: 30_000 });
  await expect(usageModal(page)).toBeVisible();
}

/** The footer's Usage item, its summary of pinned windows. */
export async function openUsageFromItem(page: Page): Promise<void> {
  await usageItem(page).click();
  await expect(usageModal(page)).toBeVisible();
}

/** Scrolls the Usage modal's body with the mouse wheel, as a user does. */
export async function scrollUsage(page: Page, deltaY: number): Promise<void> {
  const body = await usageModal(page).boundingBox();
  const viewport = page.viewportSize();
  if (!body || !viewport) throw new Error("Usage must be open before scrolling it.");
  // The middle of the part of the body on screen; the body itself runs past the viewport.
  const top = Math.max(body.y, 0);
  const bottom = Math.min(body.y + body.height, viewport.height);
  await page.mouse.move(body.x + body.width / 2, (top + bottom) / 2);
  await page.mouse.wheel(0, deltaY);
}

/** The modal's own Close button. */
export async function closeUsage(page: Page): Promise<void> {
  await visible(page, "usage-modal").getByRole("button", { name: "Close", exact: true }).click();
  await expect(usageModal(page)).toHaveCount(0);
}

/** A tap on the backdrop above the bottom sheet. */
export async function closeUsageFromBackdrop(page: Page): Promise<void> {
  const sheet = usageModal(page);
  await waitForSettledPosition(sheet);
  const bounds = await visible(page, "usage-modal").boundingBox();
  if (!bounds) throw new Error("Usage must be open before closing it.");
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y / 2);
  await expect(sheet).toHaveCount(0);
}

function summaryInSidebarSwitch(page: Page): Locator {
  return page.getByRole("switch", { name: "Summary in sidebar", exact: true });
}

/** Turns the sidebar Usage summary on or off from the Usage modal's Settings. */
export async function setSummaryInSidebar(page: Page, on: boolean): Promise<void> {
  await openUsageOptions(page);
  await summaryInSidebarSwitch(page).click();
  await expectSummaryInSidebar(page, on);
}

export async function expectSummaryInSidebar(page: Page, on: boolean): Promise<void> {
  await openUsageOptions(page);
  await expect(summaryInSidebarSwitch(page)).toBeChecked({ checked: on });
  await closeUsageOptions(page);
}

/** Open the cog's settings popover or compact sheet. */
export async function openUsageOptions(page: Page): Promise<void> {
  if (!(await visible(page, "usage-display-used").isVisible())) {
    await visible(page, "usage-options-menu").click();
  }
  await expect(visible(page, "usage-display-used")).toBeVisible();
}

export function usageOptionsSurface(page: Page): Locator {
  return page
    .locator(
      '[data-testid="usage-options-surface"]:visible, [data-testid="usage-options-surface-content"]:visible',
    )
    .first();
}

export async function expectUsageOptionsFitContent(page: Page): Promise<void> {
  await waitForSettledPosition(usageOptionsSurface(page));
  const surface = await usageOptionsSurface(page).boundingBox();
  const fields = await page.getByTestId("usage-options-fields").boundingBox();
  if (!surface || !fields) throw new Error("Settings must be visible before measuring its fit.");
  expect(surface.y + surface.height - (fields.y + fields.height)).toBeLessThanOrEqual(10);
}

export async function closeUsageOptions(page: Page): Promise<void> {
  await waitForSettledPosition(usageOptionsSurface(page));
  await page.mouse.click(0, 0);
  await expect(page.getByTestId("usage-display-used")).toHaveCount(0);
}

export async function showUsageAs(page: Page, displayAs: "used" | "remaining") {
  await openUsageOptions(page);
  await visible(page, `usage-display-${displayAs}`).click();
  await expect(visible(page, `usage-display-${displayAs}`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await closeUsageOptions(page);
}

export async function refreshAllUsage(page: Page): Promise<void> {
  await visible(page, "usage-refresh-all").click();
}

/** Opens the compact sidebar drawer. */
export async function openCompactSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
}
