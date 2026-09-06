import { expect, test, type Page } from "../support/fixtures";
import { clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

interface OpenTerminalTab {
  id: string;
  tab: ReturnType<Page["getByTestId"]>;
}

async function listTerminalIds(workspace: SeededWorkspace): Promise<string[]> {
  const result = await workspace.client.listTerminals(workspace.repoPath, undefined, {
    workspaceId: workspace.workspaceId,
  });
  return result.terminals.map((terminal) => terminal.id);
}

async function openTerminalTab(page: Page, workspace: SeededWorkspace): Promise<OpenTerminalTab> {
  const previousIds = new Set(await listTerminalIds(workspace));
  await clickNewTerminal(page);

  let createdId: string | undefined;
  await expect
    .poll(
      async () => {
        const ids = await listTerminalIds(workspace);
        const createdIds = ids.filter((id) => !previousIds.has(id));
        createdId = createdIds[0];
        return createdIds;
      },
      { timeout: 30_000 },
    )
    .toHaveLength(1);
  if (!createdId) {
    throw new Error("New terminal did not appear in the isolated daemon");
  }

  const tab = page.getByTestId(`workspace-tab-terminal_${createdId}`).filter({ visible: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  return { id: createdId, tab };
}

function pinGlyph(tab: OpenTerminalTab["tab"]) {
  return tab.locator('svg:has(path[d="M12 17v5"])');
}

async function openTabContextMenu(tab: OpenTerminalTab): Promise<void> {
  await tab.tab.click({ button: "right" });
  await expect(tab.tab.page().getByTestId(`workspace-tab-context-terminal_${tab.id}`)).toBeVisible({
    timeout: 10_000,
  });
}

async function acceptCloseOtherTabs(page: Page, tab: OpenTerminalTab): Promise<void> {
  await openTabContextMenu(tab);
  const closeOthers = page.getByTestId(`workspace-tab-context-terminal_${tab.id}-close-others`);
  await expect(closeOthers).toHaveText("Close other tabs");

  const dialogMessage = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    await dialog.accept();
    return message;
  });
  await closeOthers.click();
  await expect(dialogMessage).resolves.toContain("Close other tabs?");
}

test.describe("Pinned workspace tabs", () => {
  test("pins a terminal tab and protects it from Close other tabs", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const workspace = await seedWorkspace({ repoPrefix: "pinned-tabs-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      const pinned = await openTerminalTab(page, workspace);
      const anchor = await openTerminalTab(page, workspace);
      const disposable = await openTerminalTab(page, workspace);

      await openTabContextMenu(pinned);
      const pinItem = page.getByTestId(`workspace-tab-context-terminal_${pinned.id}-pin`);
      await expect(pinItem).toHaveText("Pin tab");
      await page.screenshot({ path: testInfo.outputPath("01-pin-tab-menu.png"), fullPage: false });
      await pinItem.click();

      await expect(pinGlyph(pinned.tab)).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-testid^="workspace-tab-terminal_"]:visible')).toHaveCount(3);
      await page.screenshot({
        path: testInfo.outputPath("02-pinned-tab-row.png"),
        fullPage: false,
      });

      await acceptCloseOtherTabs(page, anchor);

      await expect(pinned.tab).toBeVisible();
      await expect(pinGlyph(pinned.tab)).toBeVisible();
      await expect(anchor.tab).toBeVisible();
      await expect(disposable.tab).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator('[data-testid^="workspace-tab-terminal_"]:visible')).toHaveCount(2);
      await page.screenshot({
        path: testInfo.outputPath("03-close-others-pinned-survives.png"),
        fullPage: false,
      });

      await openTabContextMenu(pinned);
      const unpinItem = page.getByTestId(`workspace-tab-context-terminal_${pinned.id}-pin`);
      await expect(unpinItem).toHaveText("Unpin tab");
      await unpinItem.click();
      await expect(pinGlyph(pinned.tab)).toHaveCount(0);

      await acceptCloseOtherTabs(page, anchor);
      await expect(anchor.tab).toBeVisible();
      await expect(pinned.tab).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});
