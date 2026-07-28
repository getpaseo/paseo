import { buildHostWorkspaceRoute } from "../../app/src/utils/host-routes";
import { expect, test, type Page } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import {
  createIdleAgent,
  expectWorkspaceTabVisible,
} from "../../app/e2e/support/helpers/archive-tab";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { installDaemonWebSocketGate } from "../../app/e2e/support/helpers/daemon-websocket-gate";
import { expectAppRoute } from "../../app/e2e/support/helpers/route-assertions";
import { seedWorkspace } from "../../app/e2e/support/helpers/seed-client";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { waitForWorkspaceTabsVisible } from "../../app/e2e/support/helpers/workspace-tabs";
import {
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../../app/e2e/support/helpers/workspace-ui";
import { installDesktopRuntime, waitForDesktopDaemonStartRequest } from "./support/runtime";

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

async function expectWorkspaceLocation(
  page: Page,
  input: {
    serverId: string;
    workspace: Awaited<ReturnType<typeof seedWorkspace>>;
  },
): Promise<void> {
  await expectAppRoute(page, buildHostWorkspaceRoute(input.serverId, input.workspace.workspaceId), {
    timeout: 30_000,
  });
  await expectWorkspaceHeader(page, {
    title: input.workspace.workspaceName,
    subtitle: input.workspace.projectDisplayName,
  });
}

test("refresh keeps one continuous splash before restoring the desktop workspace", async ({
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
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
      hangDaemonStart: true,
      desktopSettingsDelayMs: 250,
      daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });
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
