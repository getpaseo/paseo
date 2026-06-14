import { test, expect, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { gotoWorkspace } from "./helpers/launcher";
import {
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  fillWorkspaceTitle,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  selectWorkspaceBacking,
  submitNewWorkspaceEmpty,
} from "./helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { expectExplorerEntryVisible } from "./helpers/file-explorer";
import { getServerId } from "./helpers/server-id";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

// Model B reshape: a workspace is the unit, its backing directory (local
// checkout or worktree) is a CHOICE at creation, and creation NEVER dedupes by
// directory. These specs drive the real creation UI (workspace-create-* test
// IDs) to prove a single directory can back any number of workspaces.

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

// On desktop the file explorer is pinned open; on narrower layouts it must be
// toggled first. Open it either way, then select the Files tab.
async function openFilesTab(page: Page): Promise<void> {
  const openButton = page.getByRole("button", { name: "Open explorer" }).first();
  if (await openButton.isVisible().catch(() => false)) {
    await openButton.click();
  }
  await page.getByTestId("explorer-tab-files").click();
  await expect(page.getByTestId("file-explorer-tree-scroll")).toBeVisible({ timeout: 30_000 });
}

async function createWorkspaceViaUi(
  page: Page,
  input: {
    project: { projectKey: string; projectDisplayName: string };
    backing: "local" | "worktree";
    title?: string;
    previousWorkspaceId: string;
    client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  },
): Promise<{ workspaceId: string; workspaceName: string; workspaceDirectory: string }> {
  await openGlobalNewWorkspaceComposer(page);
  await selectNewWorkspaceProject(page, input.project);
  await selectWorkspaceBacking(page, input.backing);
  if (input.title) {
    await fillWorkspaceTitle(page, input.title);
  }
  await submitNewWorkspaceEmpty(page);

  return assertNewWorkspaceSidebarAndHeader(page, {
    serverId: getServerId(),
    client: input.client,
    previousWorkspaceId: input.previousWorkspaceId,
    projectDisplayName: input.project.projectDisplayName,
    assertSidebarRow: false,
    assertHeader: false,
  });
}

test.describe("Workspace multiplicity creation flow", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    await client?.close().catch(() => undefined);
  });

  test("two Local workspaces share one git checkout and both are independently selectable", async ({
    page,
  }) => {
    const seeded: SeededWorkspace = await seedWorkspace({
      repoPrefix: "multiplicity-local-git-",
    });

    try {
      const project = {
        projectKey: seeded.projectId,
        projectDisplayName: seeded.projectDisplayName,
      };

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(page.getByTestId(workspaceRowTestId(seeded.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      const second = await createWorkspaceViaUi(page, {
        project,
        backing: "local",
        title: "Second local",
        previousWorkspaceId: seeded.workspaceId,
        client,
      });

      // A second workspace was minted on the SAME checkout — creation did not
      // dedupe the directory away.
      expect(second.workspaceId).not.toBe(seeded.workspaceId);
      expect(second.workspaceDirectory).toBe(seeded.workspaceDirectory);

      // Both rows live under the same project and are distinct.
      const firstRow = page.getByTestId(workspaceRowTestId(seeded.workspaceId));
      const secondRow = page.getByTestId(workspaceRowTestId(second.workspaceId));
      await expect(firstRow).toBeVisible({ timeout: 30_000 });
      await expect(secondRow).toBeVisible({ timeout: 30_000 });
      await expect(secondRow).toContainText("Second local");

      // Selecting the second workspace shows the shared checkout's files.
      await gotoWorkspace(page, second.workspaceId);
      await openFilesTab(page);
      await expectExplorerEntryVisible(page, "README.md");

      // Selecting the first workspace shows the SAME shared directory data.
      await gotoWorkspace(page, seeded.workspaceId);
      await openFilesTab(page);
      await expectExplorerEntryVisible(page, "README.md");
    } finally {
      await seeded.cleanup();
    }
  });

  test("New worktree backing creates a worktree-backed workspace in a distinct directory", async ({
    page,
  }) => {
    const seeded: SeededWorkspace = await seedWorkspace({
      repoPrefix: "multiplicity-worktree-",
    });

    try {
      const project = {
        projectKey: seeded.projectId,
        projectDisplayName: seeded.projectDisplayName,
      };

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(page.getByTestId(workspaceRowTestId(seeded.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      const worktree = await createWorkspaceViaUi(page, {
        project,
        backing: "worktree",
        previousWorkspaceId: seeded.workspaceId,
        client,
      });

      // The worktree row appears, pointing at a directory distinct from the
      // backing checkout.
      const worktreeRow = page.getByTestId(workspaceRowTestId(worktree.workspaceId));
      await expect(worktreeRow).toBeVisible({ timeout: 30_000 });
      expect(worktree.workspaceId).not.toBe(seeded.workspaceId);
      expect(worktree.workspaceDirectory).not.toBe(seeded.workspaceDirectory);

      // The daemon descriptor confirms the worktree kind (○ row).
      const descriptor = (await client.fetchWorkspaces()).entries.find(
        (entry) => entry.id === worktree.workspaceId,
      );
      expect(descriptor?.workspaceKind).toBe("worktree");

      await client
        .archivePaseoWorktree({ worktreePath: worktree.workspaceDirectory })
        .catch(() => undefined);
    } finally {
      await seeded.cleanup();
    }
  });

  test("two Local workspaces appear under the same non-git project", async ({ page }) => {
    const seeded: SeededWorkspace = await seedWorkspace({
      repoPrefix: "multiplicity-local-nongit-",
      git: false,
    });

    try {
      const project = {
        projectKey: seeded.projectId,
        projectDisplayName: seeded.projectDisplayName,
      };

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      // A non-git project with a single workspace is flattened: the project row
      // IS the workspace link, so no separate workspace row exists yet.
      await expect(page.getByTestId(`sidebar-project-row-${seeded.projectId}`)).toBeVisible({
        timeout: 30_000,
      });

      const second = await createWorkspaceViaUi(page, {
        project,
        backing: "local",
        title: "Second non-git",
        previousWorkspaceId: seeded.workspaceId,
        client,
      });

      expect(second.workspaceId).not.toBe(seeded.workspaceId);
      expect(second.workspaceDirectory).toBe(seeded.workspaceDirectory);

      // With two workspaces the project becomes an expandable section: both the
      // original and the new workspace now render as distinct rows under it.
      await expect(page.getByTestId(`sidebar-project-row-${seeded.projectId}`)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId(workspaceRowTestId(seeded.workspaceId))).toBeVisible({
        timeout: 30_000,
      });
      const secondRow = page.getByTestId(workspaceRowTestId(second.workspaceId));
      await expect(secondRow).toBeVisible({ timeout: 30_000 });
      await expect(secondRow).toContainText("Second non-git");
    } finally {
      await seeded.cleanup();
    }
  });
});
