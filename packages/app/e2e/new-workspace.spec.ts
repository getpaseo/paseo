import { existsSync } from "node:fs";
import path from "node:path";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  clickNewWorkspaceButton,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  expectComposerGithubAttachmentPill,
  expectStartingRefPickerTriggerPr,
  openNewWorkspaceComposer,
  openStartingRefPicker,
  openProjectViaDaemon,
  selectBranchInPicker,
  selectGitHubPrInPicker,
} from "./helpers/new-workspace";
import { createTempGitRepo, readWorktreeBranchInfo } from "./helpers/workspace";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
  workspaceLabelFromPath,
} from "./helpers/workspace-ui";

test.describe("New workspace flow", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const createdWorktreeIds = new Set<string>();

  test.describe.configure({ timeout: 240_000 });

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

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: secondWorkspace.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
    } finally {
      await secondRepo.cleanup();
      await firstRepo.cleanup();
    }
  });

  test("same-project workspaces switch content without requiring refresh", async ({ page }) => {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    const repo = await createTempGitRepo("workspace-nav-same-project-");

    try {
      const rootWorkspace = await openProjectViaDaemon(client, repo.path);
      const worktreeWorkspace = await createWorktreeViaDaemon(client, {
        cwd: repo.path,
        slug: `nav-${Date.now()}`,
      });
      localWorkspaceIds.add(rootWorkspace.workspaceId);
      createdWorktreeIds.add(worktreeWorkspace.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: worktreeWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: worktreeWorkspace.workspaceName,
        subtitle: worktreeWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
        selected: false,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
        selected: false,
      });
    } finally {
      await repo.cleanup();
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

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
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

      const agentTabs = page.locator('[data-testid^="workspace-tab-agent_"]');
      await expect(agentTabs).toHaveCount(1, { timeout: 30_000 });

      // Workspace setup may auto-open a setup tab that steals focus,
      // hiding the agent panel (display:none removes it from the
      // accessibility tree). Click the agent tab to ensure it's active.
      await agentTabs.first().click();

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeEditable({ timeout: 30_000 });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected branch becomes the base of a new workspace worktree", async ({ page }) => {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    const tempRepo = await createTempGitRepo("new-workspace-ref-", {
      branches: ["main", "dev"],
    });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeIds.add(createdWorkspace.workspaceId);

      expect(existsSync(createdWorkspace.workspaceId)).toBe(true);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: createdWorkspace.workspaceId,
      });
      expect(branchInfo.currentBranch).toBe(path.basename(createdWorkspace.workspaceId));
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.dev)).toBe(true);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected GitHub PR shows PR context in the trigger and composer", async ({ page }) => {
    const tempRepo = await createTempGitRepo("new-workspace-pr-ref-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, 515);

      await expectStartingRefPickerTriggerPr(page, {
        number: 515,
        title: "Review selected start ref",
        headRef: "feature/start-from-pr",
      });
      await expectComposerGithubAttachmentPill(page, {
        number: 515,
        title: "Review selected start ref",
      });
    } finally {
      await tempRepo.cleanup();
    }
  });
});
