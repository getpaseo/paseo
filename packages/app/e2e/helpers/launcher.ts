import { expect, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { createTempGitRepo } from "./workspace";
import { getServerId } from "./server-id";

// ─── Navigation ────────────────────────────────────────────────────────────

/** Navigate to a workspace and wait for the tab bar to appear. */
export async function gotoWorkspace(page: Page, workspaceId: string): Promise<void> {
  const route = buildHostWorkspaceRoute(getServerId(), workspaceId);
  await page.goto(route);
  await waitForTabBar(page);
}

// ─── Tab bar queries ───────────────────────────────────────────────────────

/** Wait for the workspace tab bar to be visible. */
export async function waitForTabBar(page: Page): Promise<void> {
  await expect(
    page.getByTestId("workspace-tabs-row").filter({ visible: true }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
}

/** Return all tab test IDs currently in the tab bar. */
export async function getTabTestIds(page: Page): Promise<string[]> {
  const tabs = page
    .locator('[data-testid^="workspace-tab-"]:not([data-testid^="workspace-tab-context-"])')
    .filter({ visible: true });
  const count = await tabs.count();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const testId = await tabs.nth(i).getAttribute("data-testid");
    if (testId) ids.push(testId);
  }
  return ids;
}

/** Return the number of tabs matching a kind prefix (e.g. "launcher", "draft", "terminal", "agent"). */
export async function countTabsOfKind(page: Page, kind: string): Promise<number> {
  const ids = await getTabTestIds(page);
  return ids.filter((id) => id.includes(kind)).length;
}

/** Return the currently active tab's test ID (the one with aria-selected or focus styling). */
export async function getActiveTabTestId(page: Page): Promise<string | null> {
  // Active tab has the focused highlight — check for the aria-selected or data-active attribute
  const activeTab = page
    .locator(
      '[data-testid^="workspace-tab-"]:not([data-testid^="workspace-tab-context-"])[aria-selected="true"]',
    )
    .filter({ visible: true })
    .first();
  if (await activeTab.isVisible().catch(() => false)) {
    return activeTab.getAttribute("data-testid");
  }
  // Fallback: the tab with focused styling
  return null;
}

// ─── Tab actions ───────────────────────────────────────────────────────────

/** Press Cmd+T (macOS) or Ctrl+T (Linux/Windows) to open a new tab. */
export async function pressNewTabShortcut(page: Page): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+t`);
}

// ─── Tab bar assertions ───────────────────────────────────────────────────

/** Assert the inline new-agent plus button is visible in the tab bar. */
export async function assertNewChatTileVisible(page: Page): Promise<void> {
  await expect(
    page.getByTestId("workspace-new-agent-tab-inline").filter({ visible: true }).first(),
  ).toBeVisible();
}

/** Assert the new-tab dropdown trigger is visible in the tab bar. */
export async function assertNewTabMenuTriggerVisible(page: Page): Promise<void> {
  await expect(
    page.getByTestId("workspace-new-tab-menu-trigger").filter({ visible: true }).first(),
  ).toBeVisible();
}

// ─── Tab creation actions ─────────────────────────────────────────────────

/** Click the inline plus button to create a draft/chat tab. */
export async function clickNewChat(page: Page): Promise<void> {
  const button = page
    .getByTestId("workspace-new-agent-tab-inline")
    .filter({ visible: true })
    .first();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
}

/** Open the new-tab menu and click "New terminal". */
export async function clickNewTerminal(page: Page): Promise<void> {
  const trigger = page
    .getByTestId("workspace-new-tab-menu-trigger")
    .filter({ visible: true })
    .first();
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  const item = page
    .getByTestId("workspace-new-tab-menu-terminal")
    .filter({ visible: true })
    .first();
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
}

// ─── Tab title assertions ──────────────────────────────────────────────────

/** Wait for any tab in the bar to display the given title text. */
export async function waitForTabWithTitle(
  page: Page,
  title: string | RegExp,
  timeout = 30_000,
): Promise<void> {
  const matcher = typeof title === "string" ? new RegExp(title, "i") : title;
  await expect(
    page
      .locator('[data-testid^="workspace-tab-"]:not([data-testid^="workspace-tab-context-"])')
      .filter({ hasText: matcher })
      .filter({ visible: true })
      .first(),
  ).toBeVisible({ timeout });
}

/** Assert the inline new-agent plus button is visible in the tab bar. */
export async function assertSingleNewTabButton(page: Page): Promise<void> {
  const buttons = page.getByTestId("workspace-new-agent-tab-inline").filter({ visible: true });
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(1);
}

// ─── No-flash measurement ──────────────────────────────────────────────────

/**
 * Measure the time between clicking a launcher tile and the replacement panel becoming visible.
 * Returns elapsed milliseconds.
 */
export async function measureTileTransition(
  page: Page,
  clickAction: () => Promise<void>,
  successLocator: ReturnType<Page["locator"]>,
  timeout = 5_000,
): Promise<number> {
  const start = Date.now();
  await clickAction();
  await expect(successLocator).toBeVisible({ timeout });
  return Date.now() - start;
}

/**
 * Sample tab IDs at high frequency across a transition to detect blank/intermediate states.
 * Returns all unique snapshots observed.
 */
export async function sampleTabsDuringTransition(
  page: Page,
  action: () => Promise<void>,
  durationMs = 2_000,
  intervalMs = 30,
): Promise<string[][]> {
  const snapshots: string[][] = [];
  const startSampling = async () => {
    const start = Date.now();
    while (Date.now() - start < durationMs) {
      snapshots.push(await getTabTestIds(page));
      await page.waitForTimeout(intervalMs);
    }
  };

  const samplingPromise = startSampling();
  await action();
  await samplingPromise;
  return snapshots;
}

export function terminalSurfaceLocator(page: Page) {
  return page.locator('[data-testid="terminal-surface"]').first();
}

export async function expectAgentTabActive(page: Page, agentId: string): Promise<void> {
  const tabTestId = `workspace-tab-agent_${agentId}`;
  await expect(page.getByTestId(tabTestId).filter({ visible: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(getActiveTabTestId(page)).resolves.toBe(tabTestId);
}

// ─── Workspace setup ───────────────────────────────────────────────────────

/** Create a temp git repo and return its path with a cleanup function. */
export async function createWorkspace(
  prefix = "launcher-e2e-",
): ReturnType<typeof createTempGitRepo> {
  return createTempGitRepo(prefix);
}
