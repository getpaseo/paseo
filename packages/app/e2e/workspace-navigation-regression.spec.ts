import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test, type Page } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import {
  createIdleAgent,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openWorkspaceWithAgents,
} from "./helpers/archive-tab";
import { expectComposerVisible } from "./helpers/composer";
import { daemonWsRoutePattern, getE2EDaemonPort } from "./helpers/daemon-port";
import { seedWorkspace } from "./helpers/seed-client";
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
import { clickSettingsBackToWorkspace } from "./helpers/settings";
import { getServerId } from "./helpers/server-id";
import { injectDesktopBridge, waitForDesktopDaemonStartRequest } from "./helpers/desktop-updates";
import { expectAppRoute } from "./helpers/route-assertions";
import { installDaemonWebSocketGate } from "./helpers/daemon-websocket-gate";

const LOADING_WORKSPACE_TEXT_PATTERN = /Loading workspace/i;
type StartupPresentation = "splash" | "app";

declare global {
  interface Window {
    __paseoStartupPresentationTrace?: StartupPresentation[];
  }
}

async function observeStartupPresentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const trace: StartupPresentation[] = [];
    window.__paseoStartupPresentationTrace = trace;

    document.addEventListener("DOMContentLoaded", () => {
      const recordPresentation = () => {
        let presentation: StartupPresentation | null = null;
        if (document.querySelector('[data-testid="startup-splash"]')) {
          presentation = "splash";
        } else if (
          document.querySelector(
            '[data-testid="workspace-header-title"], [data-testid="sidebar-settings"]',
          )
        ) {
          presentation = "app";
        }
        if (presentation && trace.at(-1) !== presentation) {
          trace.push(presentation);
        }
      };
      new MutationObserver(recordPresentation).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      recordPresentation();
    });
  });
}

async function getStartupPresentation(page: Page): Promise<StartupPresentation[]> {
  return page.evaluate(() => window.__paseoStartupPresentationTrace?.slice() ?? []);
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

async function getVisibleDraftTabCount(page: Page): Promise<number> {
  return page.locator('[data-testid^="workspace-tab-draft"]').filter({ visible: true }).count();
}

async function closeFirstVisibleDraftTab(page: Page): Promise<void> {
  const closeButton = page.locator('[data-testid^="workspace-draft-close-"]').filter({
    visible: true,
  });
  await expect(closeButton.first()).toBeVisible({ timeout: 30_000 });
  await closeButton.first().click();
}

async function openWorkspaceThroughApp(
  page: Page,
  input: {
    serverId: string;
    workspace: Awaited<ReturnType<typeof seedWorkspace>>;
  },
): Promise<void> {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await switchWorkspaceViaSidebar({
    page,
    serverId: input.serverId,
    workspaceId: input.workspace.workspaceId,
  });
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceLocation(page, input);
}

async function expectWorkspaceLocation(
  page: Page,
  input: {
    serverId: string;
    workspace: Awaited<ReturnType<typeof seedWorkspace>>;
  },
): Promise<void> {
  const workspaceRoute = buildHostWorkspaceRoute(input.serverId, input.workspace.workspaceId);
  await expectAppRoute(page, workspaceRoute, { timeout: 30_000 });
  await expectWorkspaceHeader(page, {
    title: input.workspace.workspaceName,
    subtitle: input.workspace.projectDisplayName,
  });
}

test.describe("Workspace navigation regression", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps one replacement draft after returning from settings and closing the last tab", async ({
    page,
    withWorkspace,
  }) => {
    const workspace = await withWorkspace({ prefix: "workspace-settings-back-tab-" });

    await workspace.navigateTo();
    await expect.poll(() => getVisibleDraftTabCount(page), { timeout: 30_000 }).toBe(1);

    await openSettings(page);
    await clickSettingsBackToWorkspace(page);
    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    await expect.poll(() => getVisibleDraftTabCount(page), { timeout: 30_000 }).toBe(1);

    await closeFirstVisibleDraftTab(page);

    await expect.poll(() => getVisibleDraftTabCount(page), { timeout: 30_000 }).toBe(1);
  });

  test("keeps the workspace rendered while reconnecting to the host", async ({ page }) => {
    const serverId = getServerId();

    const daemonGate = await installDaemonWebSocketGate(page);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-reconnect-" });

    try {
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `workspace-reconnect-${Date.now()}`,
      });

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));
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
      await workspace.cleanup();
    }
  });

  test("cold offline workspace route gates the screen interior but keeps settings reachable", async ({
    page,
  }) => {
    const serverId = getServerId();

    await page.routeWebSocket(daemonWsRoutePattern(), async (ws) => {
      await ws.close({ code: 1008, reason: "Blocked cold offline workspace route test." });
    });

    await page.goto(buildHostWorkspaceRoute(serverId, "/tmp/paseo-missing-workspace"));

    await expectHostConnectingOrOffline(page);
    await expectMenuButtonVisible(page);
    await expectWorkspaceHeaderAbsent(page);
    await expectWorkspaceTabsAbsent(page);
    await openSettings(page);
    await expect(page).toHaveURL(/\/settings\/general$/);
  });

  test("cold workspace URL keeps sidebar workspace navigation functional", async ({ page }) => {
    const serverId = getServerId();

    const firstWorkspace = await seedWorkspace({ repoPrefix: "workspace-cold-url-a-" });
    const secondWorkspace = await seedWorkspace({ repoPrefix: "workspace-cold-url-b-" });

    try {
      await page.goto(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId));
      await waitForSidebarHydration(page);
      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, firstWorkspace.workspaceId), {
        timeout: 30_000,
      });

      const secondRow = page.getByTestId(
        `sidebar-workspace-row-${serverId}:${secondWorkspace.workspaceId}`,
      );
      await expect(secondRow).toBeVisible({ timeout: 30_000 });
      await secondRow.click();

      await expect(page).toHaveURL(buildHostWorkspaceRoute(serverId, secondWorkspace.workspaceId), {
        timeout: 30_000,
      });
    } finally {
      await secondWorkspace.cleanup();
      await firstWorkspace.cleanup();
    }
  });

  test("refresh keeps one continuous splash before restoring the workspace route", async ({
    page,
  }) => {
    const serverId = getServerId();
    const daemonGate = await installDaemonWebSocketGate(page);
    const workspace = await seedWorkspace({ repoPrefix: "workspace-refresh-route-" });

    try {
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `workspace-refresh-route-${Date.now()}`,
      });
      await injectDesktopBridge(page, {
        serverId,
        manageBuiltInDaemon: true,
        hangDaemonStart: true,
        desktopSettingsDelayMs: 250,
        daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
      });
      await openWorkspaceThroughApp(page, { serverId, workspace });
      await waitForWorkspaceTabsVisible(page);
      await expectWorkspaceTabVisible(page, agent.id);
      await expectWorkspaceLocation(page, { serverId, workspace });

      await observeStartupPresentation(page);
      await daemonGate.drop();
      await page.reload();
      await waitForDesktopDaemonStartRequest(page);
      daemonGate.restore();
      await waitForSidebarHydration(page);

      await expectWorkspaceLocation(page, { serverId, workspace });
      await waitForWorkspaceTabsVisible(page);
      expect(await getStartupPresentation(page)).toEqual(["splash", "app"]);
    } finally {
      daemonGate.restore();
      await workspace.cleanup();
    }
  });

  test("sidebar navigation and reload keep workspace selection and tabs aligned", async ({
    page,
  }) => {
    const serverId = getServerId();

    const firstWorkspace = await seedWorkspace({ repoPrefix: "workspace-nav-reg-a-" });
    const secondWorkspace = await seedWorkspace({ repoPrefix: "workspace-nav-reg-b-" });

    try {
      const firstAgent = await createIdleAgent(firstWorkspace.client, {
        cwd: firstWorkspace.repoPath,
        workspaceId: firstWorkspace.workspaceId,
        title: `workspace-nav-a-${Date.now()}`,
      });
      const secondAgent = await createIdleAgent(secondWorkspace.client, {
        cwd: secondWorkspace.repoPath,
        workspaceId: secondWorkspace.workspaceId,
        title: `workspace-nav-b-${Date.now()}`,
      });

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
        workspaceId: firstWorkspace.workspaceId,
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
        workspaceId: secondWorkspace.workspaceId,
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
        workspaceId: firstWorkspace.workspaceId,
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
      await secondWorkspace.cleanup();
      await firstWorkspace.cleanup();
    }
  });
});
