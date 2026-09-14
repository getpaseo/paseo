import { existsSync } from "node:fs";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectWorkspaceAbsentFromSidebar,
  selectWorkspaceInSidebar,
} from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.describe("Workspace archive shortcut", () => {
  test("archives the selected workspace without removing its local checkout", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+Shift+Backspace`);

      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      expect(existsSync(workspace.repoPath)).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });
});

test("repeated archive shortcuts select adjacent workspaces in sidebar order", async ({ page }) => {
  const workspaces: SeededWorkspace[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      workspaces.push(await seedWorkspace({ repoPrefix: `archive-next-${index}-` }));
    }
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const rows = page.locator('[data-testid^="sidebar-workspace-row-"]');
    await expect(rows).toHaveCount(3);
    const rowIds = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-testid")),
    );
    const ordered = rowIds.map((rowId) => {
      const workspace = workspaces.find((item) => rowId?.endsWith(`:${item.workspaceId}`));
      if (!workspace) throw new Error(`Unknown sidebar row: ${rowId}`);
      return workspace;
    });
    const [first, second, third] = ordered;
    if (!first || !second || !third) throw new Error("Expected three workspace rows");
    await selectWorkspaceInSidebar(page, second.workspaceId);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    await page.keyboard.press(`${modifier}+Shift+Backspace`);
    await expectWorkspaceAbsentFromSidebar(page, second.workspaceId);
    await expect(page).toHaveURL(new RegExp(`/workspace/${third.workspaceId}$`));

    await page.keyboard.press(`${modifier}+Shift+Backspace`);
    await expectWorkspaceAbsentFromSidebar(page, third.workspaceId);
    await expect(page).toHaveURL(new RegExp(`/workspace/${first.workspaceId}$`));

    await page.keyboard.press(`${modifier}+Shift+Backspace`);
    await expectWorkspaceAbsentFromSidebar(page, first.workspaceId);
    await expect(page).toHaveURL(/\/new\?/);
    for (const workspace of workspaces) expect(existsSync(workspace.repoPath)).toBe(true);
  } finally {
    for (const workspace of workspaces) await workspace.cleanup();
  }
});
