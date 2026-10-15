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
  const focusScope = scroll.closest("[data-window-content]")?.parentElement?.closest("[tabindex]");
  if (!content || !focusScope) throw new Error("Expected chat content and its focus scope");
  const contentRect = content.getBoundingClientRect();
  const chatX = (contentRect.left + contentRect.right) / 2;
  const tabRow = [...document.querySelectorAll('[data-testid="workspace-tabs-row"]')].find(
    (row) => {
      const rect = row.getBoundingClientRect();
      return rect.left < chatX && rect.right > chatX && rect.height > 0;
    },
  );
  if (!tabRow) throw new Error("Expected the chat pane's tab row");
  const tabRect = tabRow.getBoundingClientRect();
  const tabY = tabRect.top + tabRect.height / 2;
  const exclusions = [...scroll.querySelectorAll("*")].filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      style.visibility === "visible" &&
      style.getPropertyValue("-webkit-app-region") === "no-drag" &&
      ((rect.top < headerY && rect.bottom > headerY) || (rect.top < tabY && rect.bottom > tabY)) &&
      rect.right > headerRect.left &&
      rect.left < headerRect.right
    );
  });
  return {
    contentCrossesHeader: contentRect.top < headerY && contentRect.bottom > headerY,
    contentCrossesTabRow: contentRect.top < tabY && contentRect.bottom > tabY,
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
      `Paragraph ${index}: a long conversation keeps the chat scrolled below its first message.\n\n[Drag reference](https://example.com) and [file.ts](./file.ts)\n\n\`\`\`ts\nconst item = ${index};\n\`\`\``,
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
          contentCrossesTabRow: true,
          focusScopeRegion: "no-drag",
          exclusions: 0,
        });
    }

    // Window-owned controls are siblings of workspace chrome, not descendants of it.
    const closeMenu = page.getByRole("button", { name: "Close menu", exact: true });
    await expect(closeMenu).toHaveCSS("-webkit-app-region", "no-drag");
    await closeMenu.click();
    const openMenu = page.getByRole("button", { name: "Open menu", exact: true });
    await expect(openMenu).toHaveCSS("-webkit-app-region", "no-drag");
    await openMenu.click();
    await expect(closeMenu).toBeVisible();

    const menuTrigger = page.getByTestId("workspace-header-menu-trigger");
    await expect(menuTrigger).toHaveCSS("-webkit-app-region", "no-drag");
    await menuTrigger.click();
    const menu = page.getByTestId("workspace-header-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toHaveCSS("-webkit-app-region", "no-drag");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await page.getByRole("textbox", { name: "Message agent...", exact: true }).click();
    // installDesktopRuntime supplies a macOS bridge, including shortcut identity.
    await page.keyboard.press("Meta+f");
    const find = page.getByRole("textbox", { name: "Find in pane", exact: true });
    await expect(find).toBeFocused();
    await expect(find).toHaveCSS("-webkit-app-region", "no-drag");
    await find.fill("Paragraph 40:");
    await expect(page.getByRole("status", { name: "Find matches" })).toHaveText("1 of 1");
    for (const name of ["Next match", "Previous match", "Close Find"]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveCSS(
        "-webkit-app-region",
        "no-drag",
      );
    }
    await page.getByRole("button", { name: "Close Find", exact: true }).click();
    await expect(find).toBeHidden();
    await expect
      .poll(() =>
        chat.evaluate((scroll) => ({
          focusReturned: document.activeElement?.contains(scroll),
          tabindex: document.activeElement?.getAttribute("tabindex"),
          appRegion: getComputedStyle(document.activeElement!).getPropertyValue(
            "-webkit-app-region",
          ),
        })),
      )
      .toEqual({ focusReturned: true, tabindex: "-1", appRegion: "no-drag" });
    await page.screenshot({ path: testInfo.outputPath("scrolled-chat-titlebar.png") });
  } finally {
    await agent.cleanup();
  }
});
