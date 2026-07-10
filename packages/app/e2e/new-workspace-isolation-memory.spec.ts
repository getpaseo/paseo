import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  expectWorkspaceIsolationSelected,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
  selectBranchInPicker,
} from "./helpers/new-workspace";
import { expectNoTruncation } from "./helpers/no-truncation";
import { createTempGitRepo } from "./helpers/workspace";
import { getServerId } from "./helpers/server-id";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

// Regression for "the local / worktree selection in the new workspace is not
// remembered." The isolation choice persists in the create-form preferences
// (FormPreferences.isolation), so it must survive the create→reopen remount:
// creating a worktree workspace navigates away from /new and unmounts it, and
// reopening New Workspace has to still show "New worktree".
test.describe("New workspace isolation memory", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceDirectory of createdWorktreeDirectories) {
        await archiveWorkspaceFromDaemon(client, workspaceDirectory).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
    }
    createdWorktreeDirectories.clear();
    localWorkspaceIds.clear();
    await client?.close().catch(() => undefined);
  });

  test("remembers the worktree isolation choice after creating a workspace", async ({ page }) => {
    const serverId = getServerId();
    const tempRepo = await createTempGitRepo("isolation-memory-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      // First visit: the screen opens on Local, switch it to New worktree and create.
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await expectWorkspaceIsolationSelected(page, "local");
      await page.getByTestId("workspace-create-isolation-trigger").click();
      const isolationPopup = page.getByTestId("combobox-desktop-container").last();
      await expect(isolationPopup).toBeVisible({ timeout: 30_000 });
      await expectNoTruncation(isolationPopup);
      await page.getByTestId("workspace-create-isolation-worktree").click();
      await expectWorkspaceIsolationSelected(page, "worktree");

      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      // Second visit (fresh mount of /new): the worktree choice must stick.
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await expectWorkspaceIsolationSelected(page, "worktree");
    } finally {
      await tempRepo.cleanup();
    }
  });
});
