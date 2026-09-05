import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import {
  closeWorkspaceAgentTab,
  createMockIdleAgent,
  openWorkspaceWithAgents,
} from "../support/helpers/archive-tab";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

for (const input of ["keyboard", "mouse"] as const) {
  test(`application history restores tabs, workspaces, Settings and plugin pages (${input})`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    if (input === "keyboard")
      await page.addInitScript(() =>
        localStorage.setItem(
          "@paseo:keyboard-shortcut-overrides",
          JSON.stringify({
            "navigation-history-back": "Ctrl+Alt+ArrowLeft",
            "navigation-history-forward": "Ctrl+Alt+ArrowRight",
          }),
        ),
      );
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
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openWorkspaceWithAgents(page, [a, b]);
      await page.goto(buildHostAgentDetailRoute(getServerId(), c.id, second.workspaceId));
      const tabA = page.getByTestId(`workspace-tab-agent_${a.id}`).filter({ visible: true });
      const tabB = page.getByTestId(`workspace-tab-agent_${b.id}`).filter({ visible: true });
      const tabC = page.getByTestId(`workspace-tab-agent_${c.id}`).filter({ visible: true });
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
      const pluginPage = page
        .getByText("History plugin page", { exact: true })
        .filter({ visible: true });
      await expect(pluginPage).toBeVisible();
      const pluginPath = new URL(page.url()).pathname;
      await openSettings(page);
      await page.getByText("Appearance", { exact: true }).filter({ visible: true }).click();
      await expect(page).toHaveURL(/\/settings\/appearance$/);

      const cdp = input === "mouse" ? await page.context().newCDPSession(page) : null;
      const navigate = async (direction: "back" | "forward") => {
        if (!cdp) {
          await page.keyboard.press(`Control+Alt+Arrow${direction === "back" ? "Left" : "Right"}`);
          return;
        }
        // Trusted side-button input exercises Chromium's default navigation too.
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: direction,
          buttons: direction === "back" ? 8 : 16,
          x: 500,
          y: 200,
          clickCount: 1,
        });
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: direction,
          buttons: 0,
          x: 500,
          y: 200,
          clickCount: 1,
        });
      };
      const back = () => navigate("back");
      const forward = () => navigate("forward");
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
      await tabB.hover();
      await closeWorkspaceAgentTab(page, b.id);
      await expect(tabA).toHaveAttribute("aria-selected", "true");
      await back();
      await expect(page.getByTestId(`workspace-tab-agent_${b.id}`)).toHaveCount(0);
      await expect(tabC).toHaveAttribute("aria-selected", "true");
      await forward();
      await expect(tabA).toHaveAttribute("aria-selected", "true");
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
  });
}
