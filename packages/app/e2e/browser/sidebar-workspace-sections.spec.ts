import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

function workspaceKey(workspaceId: string): string {
  return `${getServerId()}:${workspaceId}`;
}

test("organizes project workspaces through sections without changing daemon membership", async ({
  page,
}) => {
  const first = await seedWorkspace({ repoPrefix: "sidebar-sections-", title: "First" });
  const secondResult = await first.client.createWorkspace({
    source: { kind: "directory", path: first.repoPath, projectId: first.projectId },
    title: "Second",
  });
  const second = secondResult.workspace;
  if (!second) throw new Error(secondResult.error ?? "Failed to create second workspace");

  const projectViewKey = projectEquivalenceViewKey(first.projectKey);
  const firstRow = page.getByTestId(`sidebar-workspace-row-${workspaceKey(first.workspaceId)}`);
  const secondRow = page.getByTestId(`sidebar-workspace-row-${workspaceKey(second.id)}`);

  try {
    await gotoAppShell(page);
    await expect(firstRow).toBeVisible({ timeout: 30_000 });
    await expect(secondRow).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(`sidebar-project-row-${projectViewKey}`).hover();
    await page.getByTestId(`sidebar-project-kebab-${projectViewKey}`).click();
    await page.getByTestId(`sidebar-project-menu-new-section-${projectViewKey}`).click();
    const dialog = page.getByTestId(`sidebar-workspace-section-dialog-${projectViewKey}`);
    await dialog
      .getByTestId(`sidebar-workspace-section-dialog-${projectViewKey}-input`)
      .fill("Finance");
    await dialog.getByTestId(`sidebar-workspace-section-dialog-${projectViewKey}-submit`).click();

    const financeHeader = page.locator(
      `[data-testid^="sidebar-workspace-section-header-section_"][data-testid$="-${projectViewKey}"]`,
    );
    await expect(financeHeader).toHaveText("Finance");
    const financeHeaderId = await financeHeader.getAttribute("data-testid");
    if (!financeHeaderId) throw new Error("Missing Finance section test id");
    const financeSectionId = financeHeaderId
      .replace("sidebar-workspace-section-header-", "")
      .replace(`-${projectViewKey}`, "");

    await secondRow.hover();
    await page.getByTestId(`sidebar-workspace-kebab-${workspaceKey(second.id)}`).click();
    await page.getByTestId(`sidebar-workspace-menu-sections-${workspaceKey(second.id)}`).click();
    await page
      .getByTestId(`sidebar-workspace-section-${financeSectionId}-${workspaceKey(second.id)}`)
      .click();

    const unsectionedHeader = page.getByTestId(
      `sidebar-workspace-section-header-unsectioned-${projectViewKey}`,
    );
    await unsectionedHeader.click();
    await expect(firstRow).toHaveCount(0);
    await unsectionedHeader.click();
    await expect(firstRow).toBeVisible();

    await page
      .getByTestId(`sidebar-workspace-section-menu-${financeSectionId}-${projectViewKey}`)
      .click();
    page.once("dialog", (confirmDialog) => confirmDialog.accept());
    await page
      .getByTestId(`sidebar-workspace-section-delete-${financeSectionId}-${projectViewKey}`)
      .click();
    await expect(financeHeader).toHaveCount(0);
    await expect(secondRow).toBeVisible();
    const remaining = await first.client.fetchWorkspaces({
      filter: { projectId: first.projectId },
    });
    expect(remaining.entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([first.workspaceId, second.id]),
    );
  } finally {
    await first.cleanup();
  }
});
