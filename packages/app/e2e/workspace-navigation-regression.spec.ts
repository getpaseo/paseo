import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveAgentFromDaemon,
  connectArchiveTabDaemonClient,
  createIdleAgent,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openWorkspaceWithAgents,
} from "./helpers/archive-tab";
import {
  archiveLocalWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { createTempGitRepo } from "./helpers/workspace";
import {
  getVisibleWorkspaceAgentTabIds,
  expectOnlyWorkspaceAgentTabsVisible,
  waitForWorkspaceTabsVisible,
} from "./helpers/workspace-tabs";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "./helpers/workspace-ui";

test.describe("Workspace navigation regression", () => {
  test.describe.configure({ timeout: 240_000 });

  test("sidebar navigation and reload keep workspace selection and tabs aligned", async ({
    page,
  }) => {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    const workspaceClient = await connectNewWorkspaceDaemonClient();
    const archiveClient = await connectArchiveTabDaemonClient();
    const workspaceIds = new Set<string>();
    const agentIds: string[] = [];
    const firstRepo = await createTempGitRepo("workspace-nav-reg-a-");
    const secondRepo = await createTempGitRepo("workspace-nav-reg-b-");

    try {
      const firstWorkspace = await openProjectViaDaemon(workspaceClient, firstRepo.path);
      const secondWorkspace = await openProjectViaDaemon(workspaceClient, secondRepo.path);
      workspaceIds.add(firstWorkspace.workspaceId);
      workspaceIds.add(secondWorkspace.workspaceId);

      const firstAgent = await createIdleAgent(archiveClient, {
        cwd: firstRepo.path,
        title: `workspace-nav-a-${Date.now()}`,
      });
      const secondAgent = await createIdleAgent(archiveClient, {
        cwd: secondRepo.path,
        title: `workspace-nav-b-${Date.now()}`,
      });
      agentIds.push(firstAgent.id, secondAgent.id);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openWorkspaceWithAgents(page, [firstAgent, secondAgent]);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: firstWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
        selected: false,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
      await expectWorkspaceTabVisible(page, firstAgent.id);
      await expectWorkspaceTabHidden(page, secondAgent.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [firstAgent.id]);
      await expect(getVisibleWorkspaceAgentTabIds(page)).resolves.toEqual([
        `workspace-tab-agent_${firstAgent.id}`,
      ]);

      const firstDeckEntry = page.getByTestId(
        `workspace-deck-entry-${serverId}:${firstWorkspace.workspaceId}`,
      );
      const secondDeckEntry = page.getByTestId(
        `workspace-deck-entry-${serverId}:${secondWorkspace.workspaceId}`,
      );
      await expect(firstDeckEntry).toBeVisible({ timeout: 30_000 });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: secondWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, secondWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
        selected: false,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });
      await expectWorkspaceTabVisible(page, secondAgent.id);
      await expectWorkspaceTabHidden(page, firstAgent.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [secondAgent.id]);
      await expect(getVisibleWorkspaceAgentTabIds(page)).resolves.toEqual([
        `workspace-tab-agent_${secondAgent.id}`,
      ]);
      await expect(firstDeckEntry).toBeAttached();
      await expect(firstDeckEntry).toBeHidden();
      await expect(secondDeckEntry).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('[data-testid^="workspace-deck-entry-"]')).toHaveCount(2);

      await page.evaluate(
        ({ agentId, serverId }) => {
          globalThis.dispatchEvent(
            new CustomEvent("paseo:web-notification-click", {
              detail: {
                data: {
                  serverId,
                  agentId,
                  reason: "finished",
                },
              },
              cancelable: true,
            }),
          );
        },
        { agentId: secondAgent.id, serverId },
      );
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, secondWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expect(secondDeckEntry).toBeVisible({ timeout: 30_000 });
      await expectWorkspaceTabVisible(page, secondAgent.id);
      await expectWorkspaceTabHidden(page, firstAgent.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [secondAgent.id]);
      await expect(firstDeckEntry).toBeAttached();
      await expect(firstDeckEntry).toBeHidden();
      await expect(page.locator('[data-testid^="workspace-deck-entry-"]')).toHaveCount(2);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: firstWorkspace.workspaceId,
      });
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expect(firstDeckEntry).toBeVisible({ timeout: 30_000 });
      await expect(secondDeckEntry).toBeAttached();
      await expect(secondDeckEntry).toBeHidden();
      await expect(page.locator('[data-testid^="workspace-deck-entry-"]')).toHaveCount(2);

      await page.reload();
      await waitForSidebarHydration(page);
      await waitForWorkspaceTabsVisible(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId), {
        timeout: 30_000,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
      await expectWorkspaceTabVisible(page, firstAgent.id);
      await expectWorkspaceTabHidden(page, secondAgent.id);
      await expectOnlyWorkspaceAgentTabsVisible(page, [firstAgent.id]);
      await expect(getVisibleWorkspaceAgentTabIds(page)).resolves.toEqual([
        `workspace-tab-agent_${firstAgent.id}`,
      ]);
    } finally {
      for (const agentId of agentIds) {
        await archiveAgentFromDaemon(archiveClient, agentId).catch(() => undefined);
      }
      for (const workspaceId of workspaceIds) {
        await archiveLocalWorkspaceFromDaemon(workspaceClient, workspaceId).catch(() => undefined);
      }
      await archiveClient.close().catch(() => undefined);
      await workspaceClient.close().catch(() => undefined);
      await secondRepo.cleanup();
      await firstRepo.cleanup();
    }
  });
});
