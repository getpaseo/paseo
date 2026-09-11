import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { pluginRequirements } from "../support/helpers/plugin-fixture";

const PLUGIN_ID = "panel-with-agent-e2e";

test("opens a plugin reader left of an existing native chat and keeps its draft", async ({
  page,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-panel-with-agent-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const workspace = await seedWorkspace({ repoPrefix: "panel-with-agent-" });
  let installed = false;
  try {
    const agent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Native companion chat",
      model: "ten-second-stream",
      modeId: "load-test",
    });
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `
import React from "react";
import { Pressable, Text, View } from "react-native";
export default function contribute(client) {
  const workspaceId = ${JSON.stringify(workspace.workspaceId)};
  const agentId = ${JSON.stringify(agent.id)};
  function Reader() {
    return <View><Text>Companion reader content</Text>
      <Pressable accessibilityRole="button" onPress={() => client.openPanelWithAgent("reader", { workspaceId, agentId })}><Text>Open companion chat</Text></Pressable>
    </View>;
  }
  function Surface() {
    return <View>
      <Pressable accessibilityRole="button" onPress={() => client.openPanel("reader", { workspaceId, location: "explorer" })}><Text>Put reader in Explorer</Text></Pressable>
    </View>;
  }
  client.addSurface("start", Surface);
  client.addSidebarItem({ id: "start", title: "Companion test", icon: "BookOpen", surface: "start" });
  client.addWorkspacePanel({ id: "reader", title: "Companion reader", icon: "BookOpen", context: "workspace", locations: ["workspace", "explorer"], Component: Reader });
  return () => {};
}`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    installed = true;
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(buildAgentRoute(workspace.workspaceId, agent.id));
    const composer = page.getByRole("textbox", { name: "Message agent..." });
    await expect(composer).toBeVisible();
    await composer.fill("Keep my existing draft");
    await page.getByText("Companion test", { exact: true }).first().click();
    await page.getByRole("button", { name: "Put reader in Explorer", exact: true }).click();
    await expect(
      page
        .getByTestId("workspace-explorer-sidebar")
        .getByText("Companion reader content", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Open companion chat", exact: true }).click();
    const reader = page.getByText("Companion reader content", { exact: true });
    await expect(reader).toBeVisible();
    await expect(composer).toHaveValue("Keep my existing draft");
    const readerBox = await reader.boundingBox();
    const chatBox = await composer.boundingBox();
    if (!readerBox || !chatBox) throw new Error("Reader or chat missing");
    expect(readerBox.x + readerBox.width).toBeLessThanOrEqual(chatBox.x);
    await page.getByRole("button", { name: "Open companion chat", exact: true }).click();
    await expect(composer).toHaveValue("Keep my existing draft");
    await expect(reader).toHaveCount(1);
    await expect(
      page.getByTestId(`workspace-tab-agent_${agent.id}`).filter({ visible: true }),
    ).toHaveCount(1);
    await expect(page.getByTestId("workspace-split-resize-handle")).toHaveCount(1);
  } finally {
    if (installed) await client.removePlugin(PLUGIN_ID);
    await client.patchDaemonConfig({
      pluginsEnabled: previous.config.pluginsEnabled ?? false,
    });
    await client.close();
    await workspace.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
