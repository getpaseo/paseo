import { expect, test } from "../support/fixtures";
import {
  archiveWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  expectWorkspaceRuntimeSelected,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import {
  gotoNewWorkspaceForRuntime,
  seedGitProjectForRuntime,
} from "../support/helpers/new-workspace-runtime";
import { expectNoTruncation } from "../support/helpers/no-truncation";
import { getServerId } from "../support/helpers/server-id";

// Regression for "the Local / Worktree runtime selection in New Workspace is not
// remembered." The runtime choice persists in the create-form preferences, so it
// must survive the create→reopen remount: creating a Worktree workspace
// navigates away from /new and unmounts it.
test.describe("New workspace runtime memory", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    for (const workspaceDirectory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, workspaceDirectory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    await client?.close().catch(() => undefined);
  });

  test("remembers the Worktree runtime after creating a workspace", async ({ page }) => {
    const project = await seedGitProjectForRuntime();

    try {
      // First visit: the screen opens on Local, switch it to Worktree and create.
      await gotoNewWorkspaceForRuntime(page, project);
      await expectWorkspaceRuntimeSelected(page, "local");
      await page.getByRole("button", { name: "Runtime", exact: true }).click();
      const runtimePopup = page.getByRole("dialog").last();
      await expect(runtimePopup).toBeVisible({ timeout: 30_000 });
      await expectNoTruncation(runtimePopup);
      await runtimePopup.getByRole("button", { name: "Worktree", exact: true }).click();
      await expectWorkspaceRuntimeSelected(page, "worktree");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: "",
        projectDisplayName: project.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      // Second visit (fresh mount of /new): the runtime choice must stick.
      await openNewWorkspaceComposer(page, {
        projectKey: project.projectKey,
        projectDisplayName: project.projectDisplayName,
      });
      await expectWorkspaceRuntimeSelected(page, "worktree");
    } finally {
      await project.cleanup();
    }
  });
});
