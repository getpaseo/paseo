import { expect, type Page } from "@playwright/test";

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

export async function waitForWorkspaceTabsVisible(page: Page): Promise<void> {
  await expect(visibleTestId(page, "workspace-tabs-row").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(visibleTestId(page, "workspace-new-agent-tab").first()).toBeVisible({
    timeout: 30_000,
  });
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
