import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  expectWorkspaceModeSelected,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
  selectBranchInPicker,
} from "../support/helpers/new-workspace";
import { expectNoTruncation } from "../support/helpers/no-truncation";
import { createTempGitRepo } from "../support/helpers/workspace";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// The UI exposes Workspace mode, while FormPreferences remembers only its
// local/worktree isolation. Creating via New branch must therefore reopen on
// New branch, without persisting a separate action override.
test.describe("New Workspace mode memory", () => {
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

  test("remembers New branch's worktree isolation after creating a workspace", async ({ page }) => {
    const serverId = getServerId();
    const tempRepo = await createTempGitRepo("isolation-memory-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      // First visit: the screen opens on Local, switch it to New branch and create.
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await expectWorkspaceModeSelected(page, "local");
      await page.getByTestId("workspace-create-mode-trigger").click();
      const workspaceModePopup = page.getByTestId("combobox-desktop-container").last();
      await expect(workspaceModePopup).toBeVisible({ timeout: 30_000 });
      await expectNoTruncation(workspaceModePopup);
      await page.getByTestId("workspace-create-mode-branch-off").click();
      await expectWorkspaceModeSelected(page, "branch-off");

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

      // Second visit (fresh mount of /new): the worktree-backed mode must stick.
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await expectWorkspaceModeSelected(page, "branch-off");
    } finally {
      await tempRepo.cleanup();
    }
  });
});
