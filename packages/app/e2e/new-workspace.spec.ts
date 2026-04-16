import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  clickNewWorkspaceButton,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { createTempGitRepo } from "./helpers/workspace";
import {
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  workspaceLabelFromPath,
} from "./helpers/workspace-ui";

test.describe("New workspace flow", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const createdWorktreeIds = new Set<string>();

  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceId of createdWorktreeIds) {
        await archiveWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
    }
    createdWorktreeIds.clear();
    localWorkspaceIds.clear();
    await client?.close().catch(() => undefined);
  });

  test("sidebar workspace navigation updates URL and header", async ({ page }) => {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    const firstRepo = await createTempGitRepo("workspace-nav-a-");
    const secondRepo = await createTempGitRepo("workspace-nav-b-");

    try {
      const firstWorkspace = await openProjectViaDaemon(client, firstRepo.path);
      const secondWorkspace = await openProjectViaDaemon(client, secondRepo.path);
      localWorkspaceIds.add(firstWorkspace.workspaceId);
      localWorkspaceIds.add(secondWorkspace.workspaceId);

      await page.goto(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId));
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId));
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: workspaceLabelFromPath(firstRepo.path),
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: secondWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: workspaceLabelFromPath(secondRepo.path),
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: workspaceLabelFromPath(firstRepo.path),
      });
    } finally {
      await secondRepo.cleanup();
      await firstRepo.cleanup();
    }
  });

  test("clicking new workspace redirects, renders header, shows sidebar row, and keeps one draft tab", async ({
    page,
  }) => {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    const tempRepo = await createTempGitRepo("new-workspace-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await page.goto(buildHostWorkspaceRoute(serverId, openedProject.workspaceId));
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, openedProject.workspaceId));
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: workspaceLabelFromPath(tempRepo.path),
      });

      await clickNewWorkspaceButton(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeIds.add(createdWorkspace.workspaceId);

      expect(createdWorkspace.workspaceId).not.toBe(openedProject.workspaceId);
      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const createdWorkspaceRow = page.getByTestId(
        `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`,
      );
      await expect(createdWorkspaceRow).toBeVisible({ timeout: 30_000 });

      await expectWorkspaceHeader(page, {
        title: workspaceLabelFromPath(createdWorkspace.workspaceId),
        subtitle: openedProject.projectDisplayName,
      });

      const draftTabs = page.locator('[data-testid^="workspace-tab-"]').filter({
        has: page.getByText("New Agent", { exact: true }),
      });
      await expect(draftTabs).toHaveCount(1, { timeout: 30_000 });

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeEditable({ timeout: 30_000 });
    } finally {
      await tempRepo.cleanup();
    }
  });
});
