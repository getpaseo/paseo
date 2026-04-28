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

export async function waitForWorkspaceTabsVisible(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-tabs-row").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("workspace-new-agent-tab").first()).toBeVisible({
    timeout: 30_000,
  });
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
