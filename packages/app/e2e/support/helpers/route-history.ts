import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test as base } from "../fixtures";
import type { Page } from "@playwright/test";
import { seedWorkspace } from "./seed-client";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import {
  closeWorkspaceAgentTab,
  createMockIdleAgent,
  openWorkspaceWithAgents,
} from "./archive-tab";
import { gotoAppShell, openSettings } from "./app";
import { getServerId } from "./server-id";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { switchWorkspaceViaSidebar, waitForSidebarHydration } from "./workspace-ui";

interface HistoryControls {
  back(): Promise<void>;
  forward(): Promise<void>;
}

export async function configureKeyboardHistory(page: Page): Promise<HistoryControls> {
  await page.addInitScript(() =>
    localStorage.setItem(
      "@paseo:keyboard-shortcut-overrides",
      JSON.stringify({
        "navigation-history-back": "Ctrl+Alt+ArrowLeft",
        "navigation-history-forward": "Ctrl+Alt+ArrowRight",
      }),
    ),
  );
  return {
    back: () => page.keyboard.press("Control+Alt+ArrowLeft"),
    forward: () => page.keyboard.press("Control+Alt+ArrowRight"),
  };
}

export async function mouseHistory(page: Page): Promise<HistoryControls> {
  const cdp = await page.context().newCDPSession(page);
  const click = async (button: "back" | "forward", buttons: number) => {
    // Trusted side-button input exercises Chromium's default navigation too.
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button,
      buttons,
      x: 500,
      y: 200,
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button,
      buttons: 0,
      x: 500,
      y: 200,
      clickCount: 1,
    });
  };
  return { back: () => click("back", 8), forward: () => click("forward", 16) };
}

interface HistoryScenario {
  visitTabsWorkspacesAndPages(): Promise<void>;
  retraceVisits(controls: HistoryControls): Promise<void>;
  skipClosedTabs(controls: HistoryControls): Promise<void>;
  discardForwardVisitsAndResetOnReload(controls: HistoryControls): Promise<void>;
}

async function withHistoryScenario(
  page: Page,
  provide: (history: HistoryScenario) => Promise<void>,
) {
  const first = await seedWorkspace({ repoPrefix: "app-history-a-" });
  const second = await seedWorkspace({ repoPrefix: "app-history-b-" });
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-history-plugin-"));
  const pluginClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await pluginClient.getDaemonConfig();
  const pluginId = "history-e2e";

  try {
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: pluginId }));
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `
  import React from "react";
  import { Text } from "react-native";
  export default function contribute(plugin) {
    plugin.addSurface("main", () => <Text>History plugin page</Text>);
    plugin.addSidebarItem({ id: "main", title: "History test plugin", icon: "PanelsTopLeft", surface: "main" });
    return () => {};
  }
`,
    );
    await pluginClient.patchDaemonConfig({ pluginsEnabled: true });
    await pluginClient.installDirectoryPlugin(directory);
    const a = await createMockIdleAgent(first.client, {
      cwd: first.repoPath,
      workspaceId: first.workspaceId,
      title: "History A",
    });
    const b = await createMockIdleAgent(first.client, {
      cwd: first.repoPath,
      workspaceId: first.workspaceId,
      title: "History B",
    });
    const c = await createMockIdleAgent(second.client, {
      cwd: second.repoPath,
      workspaceId: second.workspaceId,
      title: "History C",
    });

    const tabA = page.getByTestId(`workspace-tab-agent_${a.id}`).filter({ visible: true });
    const tabB = page.getByTestId(`workspace-tab-agent_${b.id}`).filter({ visible: true });
    const tabC = page.getByTestId(`workspace-tab-agent_${c.id}`).filter({ visible: true });
    const pluginPage = page
      .getByText("History plugin page", { exact: true })
      .filter({ visible: true });

    let pluginPath = "";
    await provide({
      async visitTabsWorkspacesAndPages() {
        await gotoAppShell(page);
        await waitForSidebarHydration(page);
        await openWorkspaceWithAgents(page, [a, b]);
        await page.goto(buildHostAgentDetailRoute(getServerId(), c.id, second.workspaceId));
        await expect(tabC).toHaveAttribute("aria-selected", "true");
        await switchWorkspaceViaSidebar({
          page,
          serverId: getServerId(),
          workspaceId: first.workspaceId,
        });
        await tabA.click({ position: { x: 12, y: 13 } });
        await expect(tabA).toHaveAttribute("aria-selected", "true");
        await tabB.click({ position: { x: 12, y: 13 } });
        await expect(tabB).toHaveAttribute("aria-selected", "true");
        await switchWorkspaceViaSidebar({
          page,
          serverId: getServerId(),
          workspaceId: second.workspaceId,
        });
        await expect(tabC).toHaveAttribute("aria-selected", "true");
        await page.getByRole("button", { name: "History test plugin", exact: true }).click();
        await expect(pluginPage).toBeVisible();
        pluginPath = new URL(page.url()).pathname;
        await openSettings(page);
        await page.getByText("Appearance", { exact: true }).filter({ visible: true }).click();
        await expect(page).toHaveURL(/\/settings\/appearance$/);
      },
      async retraceVisits({ back, forward }: HistoryControls) {
        await back();
        await expect(page).toHaveURL(/\/settings\/general$/);
        await back();
        await expect(page).toHaveURL((url) => url.pathname === pluginPath);
        await expect(pluginPage).toBeVisible();
        await back();
        await expect(tabC).toHaveAttribute("aria-selected", "true");
        await back();
        await expect(tabB).toHaveAttribute("aria-selected", "true");
        await back();
        await expect(tabA).toHaveAttribute("aria-selected", "true");
        await forward();
        await expect(tabB).toHaveAttribute("aria-selected", "true");
        await forward();
        await expect(tabC).toHaveAttribute("aria-selected", "true");
        await forward();
        await expect(page).toHaveURL((url) => url.pathname === pluginPath);
        await expect(pluginPage).toBeVisible();
        await forward();
        await expect(page).toHaveURL(/\/settings\/general$/);
        await forward();
        await expect(page).toHaveURL(/\/settings\/appearance$/);
        await back();
        await back();
        await back();
        await expect(tabC).toHaveAttribute("aria-selected", "true");
        await back();
        await expect(tabB).toHaveAttribute("aria-selected", "true");
      },
      async skipClosedTabs({ back, forward }: HistoryControls) {
        await tabB.hover();
        await closeWorkspaceAgentTab(page, b.id);
        await expect(tabA).toHaveAttribute("aria-selected", "true");
        await back();
        await expect(page.getByTestId(`workspace-tab-agent_${b.id}`)).toHaveCount(0);
        await expect(tabC).toHaveAttribute("aria-selected", "true");
        await forward();
        await expect(tabA).toHaveAttribute("aria-selected", "true");
      },
      async discardForwardVisitsAndResetOnReload({ back, forward }: HistoryControls) {
        await openSettings(page);
        await forward();
        await expect(page).toHaveURL(/\/settings\/general$/);
        await back();
        await expect(tabA).toHaveAttribute("aria-selected", "true");
        await expect(page.locator('[data-testid^="workspace-deck-entry-"]')).toHaveCount(2);
        await page.reload();
        await expect(tabA).toHaveAttribute("aria-selected", "true");
        await back();
        await expect(tabA).toHaveAttribute("aria-selected", "true");
      },
    });
  } finally {
    await pluginClient.removePlugin(pluginId);
    await pluginClient.patchDaemonConfig({
      pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
    });
    await pluginClient.close();
    await rm(directory, { recursive: true, force: true });
    await second.cleanup();
    await first.cleanup();
  }
}

export const test = base.extend<{ history: HistoryScenario }>({
  history: async ({ page }, provide) => {
    await withHistoryScenario(page, provide);
  },
});
