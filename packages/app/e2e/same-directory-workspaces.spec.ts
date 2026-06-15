import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "./fixtures";
import { gotoWorkspace, clickNewTerminal } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { expectExplorerEntryVisible } from "./helpers/file-explorer";
import { expectNoTerminalTabs, clickFirstTerminalTab } from "./helpers/workspace-tabs";

// Model B: two workspaces can back the SAME directory. What follows from that
// split is the contract these specs pin:
//   - The right sidebar (file browser / git changes) reads the directory, so it
//     is IDENTICAL across same-directory workspaces.
//   - Tabs (agents, terminals) are owned by the workspace, so they are
//     INDEPENDENT across same-directory workspaces.

// On desktop the explorer is pinned open; on narrow layouts it must be toggled.
// Open it either way, then select the requested tab.
async function openExplorerTab(page: Page, tab: "files" | "changes"): Promise<void> {
  const openButton = page.getByRole("button", { name: "Open explorer" }).first();
  if (await openButton.isVisible().catch(() => false)) {
    await openButton.click();
  }
  await page.getByTestId(`explorer-tab-${tab}`).click();
}

async function createSecondWorkspaceOnSameDir(
  seeded: SeededWorkspace,
  title: string,
): Promise<string> {
  const created = await seeded.client.createWorkspace({
    backing: "local",
    cwd: seeded.repoPath,
    projectId: seeded.projectId,
    title,
  });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create second workspace for ${seeded.projectId}`);
  }
  // Both workspaces back the same on-disk checkout.
  return created.workspace.id;
}

test.describe("Same-directory workspaces", () => {
  test.describe.configure({ timeout: 180_000 });

  test("the right sidebar is shared: a directory change shows in both same-dir workspaces", async ({
    page,
  }) => {
    const seeded = await seedWorkspace({ repoPrefix: "same-dir-shared-" });

    try {
      const secondWorkspaceId = await createSecondWorkspaceOnSameDir(seeded, "Second view");

      // Seed an uncommitted change directly in the shared checkout. Because the
      // file browser and git diff read the directory, both workspaces must see
      // it — neither owns the directory state.
      await writeFile(
        path.join(seeded.workspaceDirectory, "SHARED_CHANGE.md"),
        "# shared change\n",
      );

      // Make the write authoritative on the daemon before the UI reads it. The
      // git status/diff is otherwise refreshed by a debounced filesystem watcher,
      // and a loaded CI host can lag that debounce past the assertion window —
      // the source of this spec's flakiness. Forcing a refresh (the same path as
      // the UI's manual refresh) recomputes the snapshot and diff now, so the
      // first subscribe on mount already includes SHARED_CHANGE.md.
      const refreshed = await seeded.client.checkoutRefresh(seeded.repoPath);
      if (!refreshed.success) {
        throw new Error(`Failed to refresh checkout: ${JSON.stringify(refreshed.error)}`);
      }

      // Workspace A: the new file shows in both the file browser and the git
      // changes view.
      await gotoWorkspace(page, seeded.workspaceId);
      await openExplorerTab(page, "files");
      await expectExplorerEntryVisible(page, "SHARED_CHANGE.md");
      await openExplorerTab(page, "changes");
      await expect(
        page.getByTestId("git-diff-scroll").getByText("SHARED_CHANGE.md", { exact: true }).first(),
      ).toBeVisible({ timeout: 30_000 });

      // Workspace B (same directory): the SAME change is visible. The right
      // sidebar content does not differ between the two views.
      await gotoWorkspace(page, secondWorkspaceId);
      await openExplorerTab(page, "files");
      await expectExplorerEntryVisible(page, "SHARED_CHANGE.md");
      await openExplorerTab(page, "changes");
      await expect(
        page.getByTestId("git-diff-scroll").getByText("SHARED_CHANGE.md", { exact: true }).first(),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await seeded.cleanup();
    }
  });

  test("workspace state is independent: a terminal opened in A does not appear in B", async ({
    page,
  }) => {
    const seeded = await seedWorkspace({ repoPrefix: "same-dir-independent-" });

    try {
      const secondWorkspaceId = await createSecondWorkspaceOnSameDir(seeded, "Independent view");

      // Open workspace A and materialize a terminal tab.
      await gotoWorkspace(page, seeded.workspaceId);
      await clickNewTerminal(page);
      await clickFirstTerminalTab(page);

      // Workspace B shares the directory but owns its own tabs: it has no
      // terminal tab, because the terminal belongs to A.
      await gotoWorkspace(page, secondWorkspaceId);
      await expectNoTerminalTabs(page);

      // Back in A, the terminal is still there — B never absorbed it.
      await gotoWorkspace(page, seeded.workspaceId);
      await clickFirstTerminalTab(page);
    } finally {
      await seeded.cleanup();
    }
  });
});
