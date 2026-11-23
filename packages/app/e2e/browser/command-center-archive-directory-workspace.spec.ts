import { existsSync } from "node:fs";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { openWorkspaceFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { expectWorkspaceAbsentFromSidebar } from "../support/helpers/sidebar";

async function isWorkspaceListed(seeded: SeededWorkspace): Promise<boolean> {
  const result = await seeded.client.fetchWorkspaces();
  return result.entries.some((entry) => entry.id === seeded.workspaceId);
}

async function expectWorkspaceArchivedOnDaemon(seeded: SeededWorkspace): Promise<void> {
  await expect.poll(() => isWorkspaceListed(seeded), { timeout: 30_000 }).toBe(false);
}

test.describe("Command center archive for a non-Git workspace", () => {
  test("archives a plain directory workspace from the command center", async ({ page }) => {
    const title = "Command Center Directory Archive";
    const seeded = await seedWorkspace({ repoPrefix: "cc-archive-dir-", title, git: false });

    try {
      await gotoAppShell(page);
      await openWorkspaceFromCommandCenter(page, seeded, title);

      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("archive");
      const archive = panel.getByRole("button", { name: /^Archive(?: workspace)?(?:\s|$)/ });
      await expect(archive).toBeVisible({ timeout: 30_000 });
      await archive.click();

      await expectWorkspaceAbsentFromSidebar(page, seeded.workspaceId);
      expect(existsSync(seeded.repoPath)).toBe(true);
    } finally {
      await seeded.cleanup();
    }
  });

  test("archives a plain directory workspace from the command center with the sidebar closed", async ({
    page,
  }) => {
    const title = "Command Center Directory Archive Closed Sidebar";
    const seeded = await seedWorkspace({ repoPrefix: "cc-archive-dir-closed-", title, git: false });

    try {
      await gotoAppShell(page);
      await openWorkspaceFromCommandCenter(page, seeded, title);

      await page.getByTestId("menu-button").click();
      await expect(page.getByTestId("sidebar-search")).toBeHidden({ timeout: 10_000 });

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+k`);
      const panel = page.getByTestId("command-center-panel");
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await panel.getByTestId("command-center-input").fill("archive");
      const archive = panel.getByRole("button", { name: /^Archive(?: workspace)?(?:\s|$)/ });
      await expect(archive).toBeVisible({ timeout: 30_000 });
      await archive.click();

      await expectWorkspaceArchivedOnDaemon(seeded);
    } finally {
      await seeded.cleanup();
    }
  });

  test("archives a plain directory workspace from the command center with its project collapsed", async ({
    page,
  }) => {
    const title = "Command Center Directory Archive Collapsed Project";
    const seeded = await seedWorkspace({
      repoPrefix: "cc-archive-dir-collapsed-",
      title,
      git: false,
    });

    try {
      await gotoAppShell(page);
      await openWorkspaceFromCommandCenter(page, seeded, title);

      const workspaceRow = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`,
      );
      await expect(workspaceRow).toBeVisible({ timeout: 30_000 });
      await page
        .getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(seeded.projectKey)}`)
        .first()
        .click();
      await expect(workspaceRow).toHaveCount(0, { timeout: 10_000 });

      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("archive");
      const archive = panel.getByRole("button", { name: /^Archive(?: workspace)?(?:\s|$)/ });
      await expect(archive).toBeVisible({ timeout: 30_000 });
      await archive.click();

      await expectWorkspaceArchivedOnDaemon(seeded);
    } finally {
      await seeded.cleanup();
    }
  });
});
