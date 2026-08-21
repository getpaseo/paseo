import { expect, type Locator, type Page } from "@playwright/test";

export async function getWorkspaceTabTestIds(page: Page): Promise<string[]> {
  const tabs = page.locator('[data-testid^="workspace-tab-"]');
  const count = await tabs.count();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const testId = await tabs.nth(index).getAttribute("data-testid");
    if (testId && !ids.includes(testId)) {
      ids.push(testId);
    }
  }
  return ids;
}

function visibleTestId(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true });
}

function sidePanel(page: Page) {
  return visibleTestId(page, "workspace-side-panel").first();
}

async function selectWorkspaceTab(tab: Locator): Promise<void> {
  if ((await tab.getAttribute("aria-selected")) !== "true") {
    // The close action overlays the chip's trailing edge on hover. Click the
    // leading icon area so Playwright does not target that separate control.
    await tab.click({ position: { x: 12, y: 13 } });
  }
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** Reveal the Side panel. It opens empty; the caller decides what goes in it. */
export async function ensureSidePanel(page: Page): Promise<Locator> {
  const toggle = page.getByTestId("workspace-explorer-toggle").first();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  const panel = sidePanel(page);
  if ((await panel.count()) === 0) {
    await toggle.click();
  }
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/**
 * Reveals the Side panel and brings one of its views up in it. Goes through the
 * pane's own `+` menu, which is there whether the pane is empty or already loaded.
 */
async function openSidePanelView(
  page: Page,
  view: { tabTestId: string; menuTestId: string; contentTestId: string; timeout?: number },
): Promise<void> {
  const panel = await ensureSidePanel(page);
  const tab = panel.getByTestId(view.tabTestId);
  if ((await tab.count()) === 0) {
    await panel.getByTestId("workspace-new-tab-menu-trigger").click();
    await visibleTestId(page, view.menuTestId).first().click();
  }
  await selectWorkspaceTab(tab);
  await expect(visibleTestId(page, view.contentTestId).first()).toBeVisible({
    timeout: view.timeout ?? 30_000,
  });
}

export async function openChangesPanel(page: Page): Promise<void> {
  await openSidePanelView(page, {
    tabTestId: "workspace-tab-working_diff",
    menuTestId: "workspace-new-tab-menu-changes",
    contentTestId: "working-diff-panel",
  });
}

export async function openFilesPanel(page: Page): Promise<void> {
  await openSidePanelView(page, {
    tabTestId: "workspace-tab-files",
    menuTestId: "workspace-new-tab-menu-files",
    contentTestId: "file-explorer-tree-scroll",
  });
}

export async function openPullRequestPanel(page: Page): Promise<void> {
  const existingTab = visibleTestId(page, "workspace-tab-pull_request").first();
  if ((await existingTab.count()) > 0) {
    await selectWorkspaceTab(existingTab);
    await expect(visibleTestId(page, "pr-pane").first()).toBeVisible({ timeout: 15_000 });
    return;
  }
  await openSidePanelView(page, {
    tabTestId: "workspace-tab-pull_request",
    menuTestId: "workspace-new-tab-menu-pull-request",
    contentTestId: "pr-pane",
    timeout: 15_000,
  });
}

export async function waitForWorkspaceTabsVisible(page: Page): Promise<void> {
  await expect(visibleTestId(page, "workspace-tabs-row").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(visibleTestId(page, "workspace-new-tab-menu-trigger").first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Open the `+` menu in the tab row and pick "New agent". */
export async function createAgentTabFromMenu(page: Page): Promise<void> {
  const trigger = visibleTestId(page, "workspace-new-tab-menu-trigger").first();
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  const item = visibleTestId(page, "workspace-new-tab-menu-agent").first();
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
}

export async function getVisibleWorkspaceAgentTabIds(page: Page): Promise<string[]> {
  const tabs = page.locator('[data-testid^="workspace-tab-agent_"]').filter({ visible: true });
  const count = await tabs.count();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const testId = await tabs.nth(index).getAttribute("data-testid");
    if (testId && !ids.includes(testId)) {
      ids.push(testId);
    }
  }
  return ids;
}

export async function expectOnlyWorkspaceAgentTabsVisible(
  page: Page,
  expectedAgentIds: string[],
): Promise<void> {
  const expected = new Set(expectedAgentIds.map((id) => `workspace-tab-agent_${id}`));
  const visible = await getVisibleWorkspaceAgentTabIds(page);
  const unexpected = visible.filter((id) => !expected.has(id));

  expect(unexpected).toEqual([]);
  expect(visible.length).toBe(expected.size);
  for (const expectedId of expectedAgentIds) {
    await expect(visibleTestId(page, `workspace-tab-agent_${expectedId}`).first()).toBeVisible({
      timeout: 30_000,
    });
  }
}

export async function ensureWorkspaceAgentPaneVisible(page: Page): Promise<void> {
  const toggle = page.getByTestId("workspace-explorer-toggle").first();
  if (!(await toggle.isVisible().catch(() => false))) {
    return;
  }
  const isExpanded = (await toggle.getAttribute("aria-expanded")) === "true";
  if (isExpanded) {
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false", {
      timeout: 10_000,
    });
  }
}

export async function expectWorkspaceTabsAbsent(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-tabs-row")).toHaveCount(0);
}

export async function expectNoTerminalTabs(page: Page): Promise<void> {
  await expect(page.locator('[data-testid^="workspace-tab-terminal_"]')).toHaveCount(0);
}

export async function clickFirstTerminalTab(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  const tab = page.locator('[data-testid^="workspace-tab-terminal_"]').first();
  await expect(tab).toBeVisible({ timeout: options?.timeout ?? 30_000 });
  await tab.click();
}

export async function expectFirstTerminalTabContains(page: Page, text: string): Promise<void> {
  await expect(page.locator('[data-testid^="workspace-tab-terminal_"]').first()).toContainText(
    text,
  );
}

export async function expectTerminalTabOpen(
  page: Page,
  options?: { timeout?: number },
): Promise<void> {
  await expect(
    page.locator('[data-testid^="workspace-tab-terminal_"]').filter({ visible: true }).first(),
  ).toBeVisible({ timeout: options?.timeout ?? 30_000 });
}

export async function sampleWorkspaceTabIds(
  page: Page,
  options: { durationMs?: number; intervalMs?: number } = {},
): Promise<string[][]> {
  const durationMs = options.durationMs ?? 2_500;
  const intervalMs = options.intervalMs ?? 50;
  const snapshots: string[][] = [];
  const start = Date.now();
  while (Date.now() - start <= durationMs) {
    snapshots.push(await getWorkspaceTabTestIds(page));
    await page.waitForTimeout(intervalMs);
  }
  return snapshots;
}
