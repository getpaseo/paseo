import { buildHostWorkspaceRoute } from "../../app/src/utils/host-routes";
import { expect, test, type Page } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { expectWorkspaceTabVisible } from "../../app/e2e/support/helpers/archive-tab";
import { getE2EDaemonPort } from "../../app/e2e/support/helpers/daemon-port";
import { installDaemonWebSocketGate } from "../../app/e2e/support/helpers/daemon-websocket-gate";
import { expectAppRoute } from "../../app/e2e/support/helpers/route-assertions";
import { seedWorkspace } from "../../app/e2e/support/helpers/seed-client";
import { openAgentRoute, seedMockAgentWorkspace } from "../../app/e2e/support/helpers/mock-agent";
import { scrollAgentChatToBottom } from "../../app/e2e/support/helpers/agent-bottom-anchor";
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
    const agent = await workspace.client.createAgent({
      provider: "mock",
      model: "ten-second-stream",
      modeId: "load-test",
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

function inspectChatDragExclusions(scroll: Element) {
  const header = document.querySelector('[data-testid="composer-dock-header"]');
  if (!header) throw new Error("Expected the workspace header");
  const headerRect = header.getBoundingClientRect();
  const headerY = headerRect.top + headerRect.height / 2;
  const content = scroll.firstElementChild;
  const focusScope = scroll.closest("[tabindex]");
  if (!content || !focusScope) throw new Error("Expected chat content and its focus scope");
  const contentRect = content.getBoundingClientRect();
  const exclusions = [...scroll.querySelectorAll("*")].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      style.visibility === "visible" &&
      style.getPropertyValue("-webkit-app-region") === "no-drag" &&
      rect.top < headerY &&
      rect.bottom > headerY &&
      rect.right > headerRect.left &&
      rect.left < headerRect.right
    );
  });
  return {
    contentCrossesHeader: contentRect.top < headerY && contentRect.bottom > headerY,
    focusScopeRegion: getComputedStyle(focusScope).getPropertyValue("-webkit-app-region"),
    exclusions: exclusions.length,
  };
}

test("scrolled chat does not exclude the workspace titlebar from dragging", async ({
  page,
}, testInfo) => {
  const response = Array.from(
    { length: 80 },
    (_, index) =>
      `Paragraph ${index}: a long conversation keeps the chat scrolled below its first message.`,
  ).join("\n\n");
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "desktop-scrolled-chat-",
    title: "Scrollable conversation",
    initialPrompt: "Show a long response",
    featureValues: { mockAssistantResponse: response },
  });

  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await installDesktopRuntime(page, {
      serverId: getServerId(),
      daemonListen: `127.0.0.1:${getE2EDaemonPort()}`,
    });
    await openAgentRoute(page, agent);
    const chat = page.getByTestId("agent-chat-scroll");
    await expect(chat).toBeVisible();

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await scrollAgentChatToBottom(page);
      // Electron can subtract no-drag rectangles outside a scroll viewport's clip.
      // Check the offending geometry, rather than DOM hit testing or a specific row style.
      await expect
        .poll(() => chat.evaluate(inspectChatDragExclusions))
        .toEqual({
          contentCrossesHeader: true,
          focusScopeRegion: "none",
          exclusions: 0,
        });
    }

    const menuTrigger = page.getByTestId("workspace-header-menu-trigger");
    await expect(menuTrigger).toHaveCSS("-webkit-app-region", "no-drag");
    await menuTrigger.click();
    const menu = page.getByTestId("workspace-header-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toHaveCSS("-webkit-app-region", "no-drag");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("scrolled-chat-titlebar.png") });
  } finally {
    await agent.cleanup();
  }
});
