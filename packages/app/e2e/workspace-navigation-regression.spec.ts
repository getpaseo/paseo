import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import type { WebSocketRoute } from "@playwright/test";
import { expect, test, type Page } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
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
import { expectComposerVisible } from "./helpers/composer";
import { createTempGitRepo } from "./helpers/workspace";
import {
  getVisibleWorkspaceAgentTabIds,
  expectOnlyWorkspaceAgentTabsVisible,
  waitForWorkspaceTabsVisible,
  expectWorkspaceTabsAbsent,
} from "./helpers/workspace-tabs";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  expectWorkspaceHeaderAbsent,
  expectMenuButtonVisible,
  expectHostConnectingOrOffline,
  expectReconnectingToastVisible,
  expectReconnectingToastGone,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  workspaceDeckEntryLocator,
  expectWorkspaceDeckEntryCount,
} from "./helpers/workspace-ui";

const LOADING_WORKSPACE_TEXT_PATTERN = /Loading workspace/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectNoLoadingWorkspacePane(
  page: Page,
  input: { label: string; durationMs?: number },
): Promise<void> {
  const durationMs = input.durationMs ?? 2000;
  const startedAt = Date.now();
  const samples: string[] = [];

  while (Date.now() - startedAt < durationMs) {
    const url = page.url();
    const text = await page
      .locator("body")
      .innerText({ timeout: 250 })
      .catch((error) => `[body unavailable: ${error instanceof Error ? error.message : error}]`);
    samples.push(`${Date.now() - startedAt}ms ${url}\n${text.slice(0, 1000)}`);

    if (LOADING_WORKSPACE_TEXT_PATTERN.test(text)) {
      throw new Error(
        `${input.label}: loading workspace pane appeared during reconnect window.\n\n${samples.join(
          "\n\n---\n\n",
        )}`,
      );
    }

    await page.waitForTimeout(100);
  }
}

async function expectNoLoadingPane(page: Page): Promise<void> {
  await expect(page.getByText(LOADING_WORKSPACE_TEXT_PATTERN)).toHaveCount(0);
}

async function installDaemonWebSocketGate(page: Page, daemonPort: string) {
  let acceptingConnections = true;
  const activeSockets = new Set<WebSocketRoute>();

  await page.routeWebSocket(new RegExp(`:${escapeRegex(daemonPort)}\\b`), (ws) => {
    if (!acceptingConnections) {
      void ws.close({ code: 1008, reason: "Blocked by workspace reconnect regression test." });
      return;
    }

    activeSockets.add(ws);
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      if (!acceptingConnections) {
        return;
      }
      try {
        server.send(message);
      } catch {
        activeSockets.delete(ws);
      }
    });

    server.onMessage((message) => {
      if (!acceptingConnections) {
        return;
      }
      try {
        ws.send(message);
      } catch {
        activeSockets.delete(ws);
      }
    });
  });

  return {
    async drop(): Promise<void> {
      acceptingConnections = false;
      const sockets = Array.from(activeSockets);
      activeSockets.clear();
      await Promise.all(
        sockets.map((ws) =>
          ws
            .close({ code: 1008, reason: "Dropped by workspace reconnect regression test." })
            .catch(() => undefined),
        ),
      );
    },
    restore(): void {
      acceptingConnections = true;
    },
  };
}

test.describe("Workspace navigation regression", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps the workspace rendered while reconnecting to the host", async ({ page }) => {
    const serverId = process.env.E2E_SERVER_ID;
    const daemonPort = process.env.E2E_DAEMON_PORT;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }
    if (!daemonPort) {
      throw new Error("E2E_DAEMON_PORT is not set.");
    }

    const daemonGate = await installDaemonWebSocketGate(page, daemonPort);

    const workspaceClient = await connectNewWorkspaceDaemonClient();
    const archiveClient = await connectArchiveTabDaemonClient();
    const workspaceIds = new Set<string>();
    const agentIds: string[] = [];
    const repo = await createTempGitRepo("workspace-reconnect-");

    try {
      const workspace = await openProjectViaDaemon(workspaceClient, repo.path);
      workspaceIds.add(workspace.workspaceId);

      const agent = await createIdleAgent(archiveClient, {
        cwd: repo.path,
        title: `workspace-reconnect-${Date.now()}`,
      });
      agentIds.push(agent.id);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.cwd));
      await page.waitForURL(
        (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
        { timeout: 60_000 },
      );
      await expectWorkspaceHeader(page, {
        title: workspace.workspaceName,
        subtitle: workspace.projectDisplayName,
      });
      await waitForWorkspaceTabsVisible(page);
      await expectWorkspaceTabVisible(page, agent.id);

      await daemonGate.drop();
      await expectReconnectingToastVisible(page);
      await expectWorkspaceHeader(page, {
        title: workspace.workspaceName,
        subtitle: workspace.projectDisplayName,
      });
      await waitForWorkspaceTabsVisible(page);
      await expectComposerVisible(page);
      await expectNoLoadingPane(page);

      const monitorReconnect = expectNoLoadingWorkspacePane(page, {
        label: "host reconnect",
      });
      daemonGate.restore();
      await expectReconnectingToastGone(page);
      await monitorReconnect;
      await expectWorkspaceHeader(page, {
        title: workspace.workspaceName,
        subtitle: workspace.projectDisplayName,
      });
      await waitForWorkspaceTabsVisible(page);
      await expectComposerVisible(page);
    } finally {
      daemonGate.restore();
      for (const agentId of agentIds) {
        await archiveAgentFromDaemon(archiveClient, agentId).catch(() => undefined);
      }
      for (const workspaceId of workspaceIds) {
        await archiveLocalWorkspaceFromDaemon(workspaceClient, workspaceId).catch(() => undefined);
      }
      await archiveClient.close().catch(() => undefined);
      await workspaceClient.close().catch(() => undefined);
      await repo.cleanup();
    }
  });

  test("cold offline workspace route gates the screen interior but keeps settings reachable", async ({
    page,
  }) => {
    const serverId = process.env.E2E_SERVER_ID;
    const daemonPort = process.env.E2E_DAEMON_PORT;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }
    if (!daemonPort) {
      throw new Error("E2E_DAEMON_PORT is not set.");
    }

    await page.routeWebSocket(new RegExp(`:${escapeRegex(daemonPort)}\\b`), async (ws) => {
      await ws.close({ code: 1008, reason: "Blocked cold offline workspace route test." });
    });

    await page.goto(
      `/h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent("/tmp/paseo-missing-workspace")}`,
    );

    await expectHostConnectingOrOffline(page);
    await expectMenuButtonVisible(page);
    await expectWorkspaceHeaderAbsent(page);
    await expectWorkspaceTabsAbsent(page);
    await openSettings(page);
    await expect(page).toHaveURL(/\/settings\/general$/);
  });

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

      const firstDeckEntry = workspaceDeckEntryLocator(page, serverId, firstWorkspace.workspaceId);
      const secondDeckEntry = workspaceDeckEntryLocator(
        page,
        serverId,
        secondWorkspace.workspaceId,
      );

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
      await expectWorkspaceDeckEntryCount(page, 2);

      await page.evaluate(
        ({ agentId, serverId: targetServerId }) => {
          globalThis.dispatchEvent(
            new CustomEvent("paseo:web-notification-click", {
              detail: {
                data: {
                  serverId: targetServerId,
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
      await expectWorkspaceDeckEntryCount(page, 2);

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
      await expectWorkspaceDeckEntryCount(page, 2);

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
