import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { submitMessage } from "../support/helpers/composer";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { expectMobileAgentSidebarHidden } from "../support/helpers/sidebar";
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

function pluginClientSource(input: { workspaceId: string; agentId: string }): string {
  return `import React, { useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useAgent, useWorkspace } from "@getpaseo/plugin/client";
import { recordComposerOpen } from "./shared/rpc";

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

function DirectCollisionSurface({ navigation }) {
  return <View>
    <Text>Direct collision surface</Text>
    {navigation ? <>
      <Pressable accessibilityRole="button" onPress={() => navigation.openWorkspace({ workspaceId: ${JSON.stringify(input.workspaceId)} })}><Text>Open workspace from plugin</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: ${JSON.stringify(input.agentId)} })}><Text>Open agent from plugin</Text></Pressable>
    </> : null}
  </View>;
}

function SidebarCollisionSurface() {
  return <View><Text>Sidebar collision surface</Text></View>;
}

function contributeClient(client) {
  const pills = new Map();
  const remove = (agentId) => {
    pills.get(agentId)?.();
    pills.delete(agentId);
  };
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      remove(update.agentId);
      return;
    }
    const agent = update.agent;
    if (agent.title !== "Plugin panel context agent" || !agent.workspaceId) return;
    remove(agent.id);
    const pill = client.addComposerPill({
      id: "review",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Open composer review",
        icon: "Scan",
        label: "Review",
        behavior: { kind: "action", async onPress() {
        await client.rpc(recordComposerOpen, { workspaceId: agent.workspaceId });
        pill.remove();
        client.openPanel("agent", {
          workspaceId: agent.workspaceId,
          agentId: agent.id,
        });
        } },
      },
    });
    pills.set(agent.id, () => pill.remove());
  });
  return () => {
    unsubscribe();
    for (const removePill of pills.values()) removePill();
    pills.clear();
  };
}

export default function contribute(client) {
  client.addSurface("collision", DirectCollisionSurface);
  client.addSurface("sidebar-destination", SidebarCollisionSurface);
  client.addSidebarItem({ id: "collision", title: "Collision sidebar", icon: "Blocks", surface: "sidebar-destination" });
  client.addWorkspacePanel({ id: "workspace", title: "Workspace inspector", icon: "PanelsTopLeft", context: "workspace", Component: WorkspacePanel });
  client.addWorkspacePanel({ id: "agent", title: "Agent inspector", icon: "PanelTop", context: "agent", Component: AgentPanel });
  client.addCommandCenterItem({ id: "global", title: "Plugin global action", icon: "Blocks", context: "global", onSelect() {} });
  client.addCommandCenterItem({ id: "surface", title: "Open direct collision surface", icon: "Blocks", context: "workspace", onSelect({ openSurface }) { openSurface("collision"); } });
  client.addCommandCenterItem({ id: "workspace", title: "Open plugin workspace", icon: "PanelsTopLeft", context: "workspace", onSelect({ openPanel }) { openPanel("workspace"); } });
  client.addCommandCenterItem({ id: "agent", title: "Open plugin agent", icon: "PanelTop", context: "agent", onSelect({ openPanel }) { openPanel("agent"); } });
  return contributeClient(client);
}`;
}

const pluginSharedSource = `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const recordComposerOpen = defineRpc({
  name: "composer.open",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ opened: z.boolean() }),
});`;

const pluginServerSource = `import { recordComposerOpen } from "./shared/rpc";

export default function contribute(server) {
  server.handle(recordComposerOpen, async ({ workspaceId }, { paseo }) => {
    await paseo.workspaces.ref(workspaceId).setTitle("Opened from composer pill");
    return { opened: true };
  });
  return () => {};
}`;

async function writePluginSources(
  directory: string,
  input: { workspaceId: string; agentId: string },
): Promise<void> {
  await mkdir(path.join(directory, "shared"), { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "index.client.tsx"), pluginClientSource(input)),
    writeFile(path.join(directory, "index.server.ts"), pluginServerSource),
    writeFile(path.join(directory, "shared", "rpc.ts"), pluginSharedSource),
  ]);
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
  await expect(page.getByTestId("sidebar-search")).toBeVisible();
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
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writePluginSources(directory, {
      workspaceId: primary.workspaceId,
      agentId: "missing-agent",
    });

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

      await test.step("surface navigation opens host-owned workspace and agent routes", async () => {
        await runCommand(page, "Open direct collision surface");
        await page.getByRole("button", { name: "Open workspace from plugin", exact: true }).click();
        await page.waitForURL(isSettledWorkspaceUrl);
        await expect(page.getByTestId("workspace-header-title")).toBeVisible();

        const agent = await primary.client.createAgent({
          provider: "mock",
          cwd: primary.repoPath,
          workspaceId: primary.workspaceId,
          title: "Plugin navigation agent",
          model: "ten-second-stream",
          modeId: "load-test",
        });
        const navigationAgentId = agent.id;
        await writePluginSources(directory, {
          workspaceId: primary.workspaceId,
          agentId: navigationAgentId,
        });
        await primaryClient.reloadPlugin(PLUGIN_ID);

        await runCommand(page, "Open direct collision surface");
        await page.getByRole("button", { name: "Open agent from plugin", exact: true }).click();
        await page.waitForURL(isSettledWorkspaceUrl);
        await expect(
          page
            .getByTestId(`workspace-tab-agent_${navigationAgentId}`)
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
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
        await submitMessage(page, "emit 1 agent stream updates");
        await expect(page.getByRole("button", { name: "1/1 tasks" })).toBeVisible({
          timeout: 30_000,
        });
        const composerPill = page.getByRole("button", { name: "Open composer review" });
        await expect(composerPill).toContainText("Review");
        await capture(page, testInfo, "plugin-composer-pill-wide");
        await page.setViewportSize(COMPACT_VIEWPORT);
        await expect(page.getByRole("button", { name: "Open composer review" })).toBeVisible();
        await capture(page, testInfo, "plugin-composer-pill-compact");
        await page.getByRole("button", { name: "Open composer review" }).click();
        await expect(page.getByTestId("workspace-header-title")).toHaveText(
          "Opened from composer pill",
        );
        await expect(page.getByText(`Agent bridge ${agent.id}`)).toBeVisible();
        await expect(page.getByText("Layout compact", { exact: true })).toBeVisible();
        await capture(page, testInfo, "plugin-agent-panel-compact");

        await page.goto(buildAgentRoute(primary.workspaceId, agent.id));
        await page.waitForURL(isSettledWorkspaceUrl, { timeout: 60_000 });
        await expect(page.getByRole("button", { name: "Open composer review" })).toHaveCount(0);
        await openCompactSidebar(page);
        // The sidebar's Search row dismisses the compact sidebar on its way to the
        // command center, so nothing has to close it after the command runs.
        await runCommand(page, "Open plugin agent");
        await expectMobileAgentSidebarHidden(page);
        await expect(page.getByText(`Agent bridge ${agent.id}`)).toBeVisible();
        await expect(
          page.getByText(`Workspace ${primary.workspaceId}`, { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(`Host ${getServerId()}`, { exact: true })).toBeVisible();
        await expect(page.getByText("Layout compact", { exact: true })).toBeVisible();
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
