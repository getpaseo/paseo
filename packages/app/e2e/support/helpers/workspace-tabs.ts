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

function setupTabTestId(workspaceId: string): string {
  return `workspace-tab-setup_${workspaceId}`;
}

async function waitForSetupToReachWorkspace(page: Page): Promise<void> {
  const actionsButton = page.getByTestId("workspace-header-menu-trigger");
  await expect(actionsButton).toBeVisible({ timeout: 30_000 });
  await actionsButton.click();
  await expect(page.getByTestId("workspace-header-show-setup")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
}

export async function expectSetupTabNotSeeded(page: Page, workspaceId: string): Promise<void> {
  await waitForSetupToReachWorkspace(page);
  const tab = page.getByTestId(setupTabTestId(workspaceId));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(tab).toHaveCount(0);
    await page.waitForTimeout(100);
  }
}

export async function expectFailedSetupTabSeededInMainPane(
  page: Page,
  workspaceId: string,
): Promise<void> {
  const tabId = setupTabTestId(workspaceId);
  await expect(page.getByTestId(tabId).filter({ visible: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  const explorer = await ensureExplorerSidebar(page);
  await expect(explorer.getByTestId(tabId)).toHaveCount(0);
}

export async function closeSetupTab(page: Page, workspaceId: string): Promise<void> {
  const tabId = setupTabTestId(workspaceId);
  await page.getByTestId(tabId).filter({ visible: true }).first().click({ button: "right" });
  await page.getByTestId(`workspace-tab-context-setup_${workspaceId}-close`).click();
  await expect(page.getByTestId(tabId)).toHaveCount(0);
}

function visibleTestId(page: Page, testId: string) {
  return page.getByTestId(testId).filter({ visible: true });
}

function explorerSidebar(page: Page) {
  return visibleTestId(page, "workspace-explorer-sidebar").first();
}

async function selectWorkspaceTab(tab: Locator): Promise<void> {
  if ((await tab.getAttribute("aria-selected")) !== "true") {
    // The close action overlays the chip's trailing edge on hover. Click the
    // leading icon area so Playwright does not target that separate control.
    await tab.click({ position: { x: 12, y: 13 } });
  }
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** Reveal the Explorer sidebar without changing its selected view. */
export async function ensureExplorerSidebar(page: Page): Promise<Locator> {
  const toggle = page.getByTestId("workspace-explorer-toggle").first();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  const explorer = explorerSidebar(page);
  if ((await explorer.count()) === 0) {
    await toggle.click();
  }
  await expect(explorer).toBeVisible({ timeout: 30_000 });
  return explorer;
}

/** Reveals the Explorer sidebar and selects one of its fixed navigation views. */
async function openExplorerView(
  page: Page,
  view: { tabTestId: string; contentTestId: string; timeout?: number },
): Promise<void> {
  const explorer = await ensureExplorerSidebar(page);
  const tab = explorer.getByTestId(view.tabTestId);
  await tab.click();
  await expect(visibleTestId(page, view.contentTestId).first()).toBeVisible({
    timeout: view.timeout ?? 30_000,
  });
}

export async function openChangesTreePanel(page: Page): Promise<void> {
  await openExplorerView(page, {
    tabTestId: "explorer-sidebar-tab-changes_tree",
    contentTestId: "changes-tree-panel",
  });
}

export async function openChangesPanel(page: Page, timeout = 30_000): Promise<void> {
  await openChangesTreePanel(page);
  const changedFile = page
    .locator('[data-testid^="diff-tree-file-"][data-testid$="-toggle"]')
    .filter({ visible: true })
    .first();
  await expect(changedFile).toBeVisible({ timeout });
  await changedFile.click();
  await expect(visibleTestId(page, "working-diff-panel").first()).toBeVisible({
    timeout,
  });
}

export async function openFilesPanel(page: Page): Promise<void> {
  await openExplorerView(page, {
    tabTestId: "explorer-sidebar-tab-files",
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
  const trigger = visibleTestId(page, "workspace-new-tab-button").first();
  await trigger.click();
  await visibleTestId(page, "workspace-new-tab-menu-pull-request").first().click();
  await expect(visibleTestId(page, "pr-pane").first()).toBeVisible({ timeout: 15_000 });
}

export async function waitForWorkspaceTabsVisible(page: Page): Promise<void> {
  await expect(visibleTestId(page, "workspace-tabs-row").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(visibleTestId(page, "workspace-new-tab-button").first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Open the pane-local `+` menu and pick Agent. */
export async function createAgentTabFromMenu(page: Page): Promise<void> {
  const trigger = visibleTestId(page, "workspace-new-tab-button").first();
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
