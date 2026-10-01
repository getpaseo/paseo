import { test, expect, type Page } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  selectWorkspaceIsolation,
  submitNewWorkspaceEmpty,
} from "../support/helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { expectExplorerEntryVisible } from "../support/helpers/file-explorer";
import { getServerId } from "../support/helpers/server-id";
import { openFilesPanel } from "../support/helpers/workspace-tabs";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

async function openFilesTab(page: Page): Promise<void> {
  await openFilesPanel(page);
}

async function createWorkspaceViaUi(
  page: Page,
  input: {
    project: { projectKey: string; projectDisplayName: string };
    isolation: "local" | "worktree" | null;
    previousWorkspaceId: string;
    client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  },
): Promise<{ workspaceId: string; workspaceName: string; workspaceDirectory: string }> {
  await openGlobalNewWorkspaceComposer(page);
  await selectNewWorkspaceProject(page, input.project);
  if (input.isolation !== null) {
    await selectWorkspaceIsolation(page, input.isolation);
  }
  await submitNewWorkspaceEmpty(page);

  const workspace = await assertNewWorkspaceSidebarAndHeader(page, {
    serverId: getServerId(),
    client: input.client,
    previousWorkspaceId: input.previousWorkspaceId,
    projectDisplayName: input.project.projectDisplayName,
    assertSidebarRow: false,
    assertHeader: false,
  });
  await openFilesTab(page);
  return workspace;
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
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      };

      await gotoWorkspace(page, seeded.workspaceId);
      await openFilesTab(page);
      await waitForSidebarHydration(page);
      await expect(page.getByTestId(workspaceRowTestId(seeded.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      const second = await createWorkspaceViaUi(page, {
        project,
        isolation: "local",
        previousWorkspaceId: seeded.workspaceId,
        client,
      });

      expect(second.workspaceId).not.toBe(seeded.workspaceId);
      expect(second.workspaceDirectory).toBe(seeded.workspaceDirectory);

      const firstRow = page.getByTestId(workspaceRowTestId(seeded.workspaceId));
      const secondRow = page.getByTestId(workspaceRowTestId(second.workspaceId));
      await expect(firstRow).toBeVisible({ timeout: 30_000 });
      await expect(secondRow).toBeVisible({ timeout: 30_000 });
      await expect(secondRow).toContainText(second.workspaceName);

      await gotoWorkspace(page, second.workspaceId);
      await openFilesTab(page);
      await expectExplorerEntryVisible(page, "README.md");

      await gotoWorkspace(page, seeded.workspaceId);
      await openFilesTab(page);
      await expectExplorerEntryVisible(page, "README.md");
    } finally {
      await seeded.cleanup();
    }
  });

  test("New worktree isolation creates a worktree-backed workspace in a distinct directory", async ({
    page,
  }) => {
    const seeded: SeededWorkspace = await seedWorkspace({
      repoPrefix: "multiplicity-worktree-",
    });

    try {
      const project = {
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      };

      await gotoWorkspace(page, seeded.workspaceId);
      await openFilesTab(page);
      await waitForSidebarHydration(page);
      await expect(page.getByTestId(workspaceRowTestId(seeded.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      const worktree = await createWorkspaceViaUi(page, {
        project,
        isolation: "worktree",
        previousWorkspaceId: seeded.workspaceId,
        client,
      });

      const worktreeRow = page.getByTestId(workspaceRowTestId(worktree.workspaceId));
      await expect(worktreeRow).toBeVisible({ timeout: 30_000 });
      expect(worktree.workspaceId).not.toBe(seeded.workspaceId);
      expect(worktree.workspaceDirectory).not.toBe(seeded.workspaceDirectory);

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
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      };

      await gotoWorkspace(page, seeded.workspaceId);
      await openFilesTab(page);
      await waitForSidebarHydration(page);
      await expect(
        page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(seeded.projectKey)}`),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(workspaceRowTestId(seeded.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      const second = await createWorkspaceViaUi(page, {
        project,
        isolation: null,
        previousWorkspaceId: seeded.workspaceId,
        client,
      });

      expect(second.workspaceId).not.toBe(seeded.workspaceId);
      expect(second.workspaceDirectory).toBe(seeded.workspaceDirectory);

      await expect(
        page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(seeded.projectKey)}`),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(workspaceRowTestId(seeded.workspaceId))).toBeVisible({
        timeout: 30_000,
      });
      const secondRow = page.getByTestId(workspaceRowTestId(second.workspaceId));
      await expect(secondRow).toBeVisible({ timeout: 30_000 });
      await expect(secondRow).toContainText(second.workspaceName);
    } finally {
      await seeded.cleanup();
    }
  });
});
