import { test, expect, type Page } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

// On desktop the tab row sits on a window drag region. Electron reads -webkit-app-region to
// decide which pixels drag the window; there, the gaps between tabs swallowed trackpad scrolls.
// The browser has no drag region, so this checks the region the tab strip declares.

async function openWorkspaceWithTerminals(
  page: Page,
  workspace: SeededWorkspace,
  count: number,
): Promise<string[]> {
  const terminalIds: string[] = [];
  for (let index = 1; index <= count; index++) {
    const result = await workspace.client.createTerminal(
      workspace.repoPath,
      `Terminal ${index}`,
      undefined,
      { workspaceId: workspace.workspaceId },
    );
    if (!result.terminal) throw new Error(`Failed to create terminal: ${result.error}`);
    terminalIds.push(result.terminal.id);
  }
  await gotoWorkspace(page, workspace.workspaceId);
  await expect(
    visibleTabsScroll(page).locator('[data-testid^="workspace-tab-terminal_"]'),
  ).toHaveCount(count, { timeout: 30_000 });
  return terminalIds;
}

function visibleTabsScroll(page: Page) {
  return page.getByTestId("workspace-tabs-scroll").filter({ visible: true }).first();
}

function appRegion(page: Page): Promise<string> {
  return visibleTabsScroll(page).evaluate((el) =>
    getComputedStyle(el).getPropertyValue("-webkit-app-region"),
  );
}

async function cleanup(workspace: SeededWorkspace, terminalIds: string[]): Promise<void> {
  await Promise.all(terminalIds.map((id) => workspace.client.killTerminal(id).catch(() => {})));
  await workspace.cleanup();
}

test("an overflowing tab strip is excluded from the window drag region", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "tabs-drag-overflow-" });
  let terminalIds: string[] = [];
  try {
    terminalIds = await openWorkspaceWithTerminals(page, workspace, 16);
    await expect
      .poll(() => visibleTabsScroll(page).evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true);

    await expect.poll(() => appRegion(page)).toBe("no-drag");
  } finally {
    await cleanup(workspace, terminalIds);
  }
});

test("a tab strip that fits leaves its empty space to the window drag region", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "tabs-drag-fit-" });
  let terminalIds: string[] = [];
  try {
    terminalIds = await openWorkspaceWithTerminals(page, workspace, 1);

    await expect.poll(() => appRegion(page)).toBe("none");
  } finally {
    await cleanup(workspace, terminalIds);
  }
});
