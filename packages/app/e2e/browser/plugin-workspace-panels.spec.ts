import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  closeMobileAgentSidebar,
  expectMobileAgentSidebarHidden,
} from "../support/helpers/sidebar";
import {
  switchWorkspaceViaSidebar,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

const PLUGIN_ID = "workspace-panel-e2e";
const WIDE_VIEWPORT = { width: 1280, height: 900 };
const COMPACT_VIEWPORT = { width: 390, height: 844 };

function isSettledWorkspaceUrl(url: URL): boolean {
  return url.pathname.includes("/workspace/") && !url.searchParams.has("open");
}

function pluginSource(): string {
  return `import React, { useRef } from "react";
import { Text, View } from "react-native";
import { useAgent, useWorkspace } from "@paseo/plugin";

function WorkspacePanel({ workspaceId, host, layout }) {
  const workspace = useWorkspace(workspaceId, (value) => ({ id: value.id }));
  const renderCount = useRef(0);
  renderCount.current += 1;
  return <View><Text>Workspace bridge {workspace?.id}</Text><Text>Workspace renders {renderCount.current}</Text><Text>Host {host.id}</Text><Text>Layout {layout.compact ? "compact" : "wide"}</Text></View>;
}

function AgentPanel({ workspaceId, agentId, host, layout }) {
  const workspace = useWorkspace(workspaceId, (value) => ({ id: value.id }));
  const agent = useAgent(agentId, (value) => ({ id: value.id }));
  return <View><Text>Agent bridge {agent?.id}</Text><Text>Workspace {workspace?.id}</Text><Text>Host {host.id}</Text><Text>Layout {layout.compact ? "compact" : "wide"}</Text></View>;
}

function DirectCollisionSurface() {
  return <View><Text>Direct collision surface</Text></View>;
}

function SidebarCollisionSurface() {
  return <View><Text>Sidebar collision surface</Text></View>;
}

export default function contribute(plugin) {
  plugin.addSurface("collision", DirectCollisionSurface);
  plugin.addSurface("sidebar-destination", SidebarCollisionSurface);
  plugin.addSidebarItem({ id: "collision", title: "Collision sidebar", icon: "Blocks", surface: "sidebar-destination" });
  plugin.addWorkspacePanel({ id: "workspace", title: "Workspace inspector", icon: "PanelsTopLeft", context: "workspace", Component: WorkspacePanel });
  plugin.addWorkspacePanel({ id: "agent", title: "Agent inspector", icon: "PanelTop", context: "agent", Component: AgentPanel });
  plugin.addCommandCenterItem({ id: "global", title: "Plugin global action", icon: "Blocks", context: "global", onSelect() {} });
  plugin.addCommandCenterItem({ id: "surface", title: "Open direct collision surface", icon: "Blocks", context: "workspace", onSelect({ openSurface }) { openSurface("collision"); } });
  plugin.addCommandCenterItem({ id: "workspace", title: "Open plugin workspace", icon: "PanelsTopLeft", context: "workspace", onSelect({ openPanel }) { openPanel("workspace"); } });
  plugin.addCommandCenterItem({ id: "agent", title: "Open plugin agent", icon: "PanelTop", context: "agent", onSelect({ openPanel }) { openPanel("agent"); } });
  return () => {};
}`;
}

async function searchCommands(page: Page, query: string) {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(query);
  return panel;
}

async function expectCommandAvailable(page: Page, title: string): Promise<void> {
  const panel = await searchCommands(page, title);
  await expect(panel.getByRole("button", { name: title, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

async function expectCommandUnavailable(page: Page, title: string): Promise<void> {
  const panel = await searchCommands(page, title);
  await expect(panel.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function runCommand(page: Page, title: string): Promise<void> {
  const panel = await searchCommands(page, title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

async function openCompactSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(page.getByTestId("sidebar-command-center-search")).toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

test.describe("plugin workspace panels and Command Center", () => {
  test.describe.configure({ timeout: 240_000 });

  test("follows workspace, agent, host, compact, and unavailable state", async ({
    page,
  }, testInfo) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-workspace-panel-e2e-"));
    const primaryClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previousConfig = await primaryClient.getDaemonConfig();
    const primary = await seedWorkspace({ repoPrefix: "plugin-panel-primary-" });
    const secondaryDaemon = await startIsolatedHostDaemon("plugin-panel-secondary");
    const secondary = await seedWorkspace({
      repoPrefix: "plugin-panel-secondary-",
      port: secondaryDaemon.port,
    });
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: PLUGIN_ID }));
    await writeFile(path.join(directory, "index.tsx"), pluginSource());

    try {
      await primaryClient.patchDaemonConfig({ pluginsEnabled: true });
      await primaryClient.installDirectoryPlugin(directory);
      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: "Secondary plugin host",
        port: secondaryDaemon.port,
        primaryLabel: "Primary plugin host",
      });
      await waitForWorkspaceInSidebar(page, {
        serverId: getServerId(),
        workspaceId: primary.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId: secondaryDaemon.serverId,
        workspaceId: secondary.workspaceId,
      });

      await test.step("workspace context opens the real wide panel bridge", async () => {
        await switchWorkspaceViaSidebar({
          page,
          serverId: getServerId(),
          workspaceId: primary.workspaceId,
        });
        await expectCommandAvailable(page, "Plugin global action");
        await expectCommandAvailable(page, "Open plugin workspace");
        await expectCommandUnavailable(page, "Open plugin agent");
        await runCommand(page, "Open plugin workspace");
        await expect(page.getByText(`Workspace bridge ${primary.workspaceId}`)).toBeVisible();
        const renderCount = Number(
          (await page.getByText(/Workspace renders \d+/).textContent())?.split(" ").at(-1),
        );
        await primaryClient.setWorkspaceTitle(primary.workspaceId, "Unrelated title update");
        await expect(page.getByTestId("workspace-header-title")).toHaveText(
          "Unrelated title update",
        );
        expect(
          Number((await page.getByText(/Workspace renders \d+/).textContent())?.split(" ").at(-1)),
        ).toBe(renderCount);
        await expect(page.getByText(`Host ${getServerId()}`, { exact: true })).toBeVisible();
        await expect(page.getByText("Layout wide", { exact: true })).toBeVisible();
        await capture(page, testInfo, "plugin-workspace-panel-wide");
      });

      await test.step("direct and sidebar routes preserve same-id contribution kind", async () => {
        await runCommand(page, "Open direct collision surface");
        await expect(page.getByText("Direct collision surface", { exact: true })).toBeVisible();
        await expect(page.getByText("Sidebar collision surface", { exact: true })).toHaveCount(0);
        await page.getByTestId("plugin-surface-close").click();

        await page.getByTestId(`plugin-sidebar-${PLUGIN_ID}-collision`).click();
        await expect(page.getByText("Sidebar collision surface", { exact: true })).toBeVisible();
        await expect(page.getByText("Direct collision surface", { exact: true })).toHaveCount(0);
        await capture(page, testInfo, "plugin-surface-kind-collision");
        await page.getByTestId("plugin-surface-close").click();
      });

      await test.step("switching hosts removes commands from an uninstalled host", async () => {
        await switchWorkspaceViaSidebar({
          page,
          serverId: secondaryDaemon.serverId,
          workspaceId: secondary.workspaceId,
        });
        await expectCommandUnavailable(page, "Plugin global action");
        await expectCommandUnavailable(page, "Open plugin workspace");
      });

      await test.step("legacy sidebar URLs survive a full browser navigation", async () => {
        await page.goto(`/h/${encodeURIComponent(getServerId())}/plugin/${PLUGIN_ID}/collision`);
        await page.waitForURL(new RegExp(`/plugin/${PLUGIN_ID}/sidebar/collision(?:\\?.*)?$`));
        await expect(page.getByText("Sidebar collision surface", { exact: true })).toBeVisible();
      });

      await test.step("agent context opens the compact panel with synchronous snapshots", async () => {
        const agent = await primary.client.createAgent({
          provider: "mock",
          cwd: primary.repoPath,
          workspaceId: primary.workspaceId,
          title: "Plugin panel context agent",
          model: "ten-second-stream",
          modeId: "load-test",
        });
        await page.goto(buildAgentRoute(primary.workspaceId, agent.id));
        await page.waitForURL(isSettledWorkspaceUrl, { timeout: 60_000 });
        await page.setViewportSize(COMPACT_VIEWPORT);
        await openCompactSidebar(page);
        await runCommand(page, "Open plugin agent");
        await closeMobileAgentSidebar(page);
        await expectMobileAgentSidebarHidden(page);
        await expect(page.getByText(`Agent bridge ${agent.id}`)).toBeVisible();
        await expect(
          page.getByText(`Workspace ${primary.workspaceId}`, { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(`Host ${getServerId()}`, { exact: true })).toBeVisible();
        await expect(page.getByText("Layout compact", { exact: true })).toBeVisible();
        await capture(page, testInfo, "plugin-agent-panel-compact");
      });

      await test.step("removing the active plugin renders the panel unavailable", async () => {
        await primaryClient.removePlugin(PLUGIN_ID);
        await expect(
          page.getByText("This plugin panel is unavailable.", { exact: true }),
        ).toBeVisible({
          timeout: 30_000,
        });
        await capture(page, testInfo, "plugin-panel-unavailable");
        await openCompactSidebar(page);
        await expectCommandUnavailable(page, "Open plugin agent");
      });
    } finally {
      await primaryClient.removePlugin(PLUGIN_ID).catch(() => undefined);
      await primaryClient
        .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      await primaryClient.close().catch(() => undefined);
      await primary.cleanup().catch(() => undefined);
      await secondary.cleanup().catch(() => undefined);
      await secondaryDaemon.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
