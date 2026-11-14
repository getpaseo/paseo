import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  createMockIdleAgent,
  expectArchivedAgentFocused,
  fetchAgentArchivedAt,
} from "../support/helpers/archive-tab";
import { openCommandCenter } from "../support/helpers/command-center";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const PLUGIN_ID = "archived-agent-navigation-e2e";

test("Explorer opens an uncached archived agent without remounting the workspace", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-archive-navigation-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const workspace = await seedWorkspace({ repoPrefix: "plugin-archive-navigation-" });

  try {
    const archived = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Archived plugin conversation",
    });
    const active = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Active plugin conversation",
    });
    // Archive before the browser connects so the active-agent snapshot cannot
    // provide this agent's workspace to plugin navigation.
    await workspace.client.archiveAgent(archived.id);
    const archivedAt = await fetchAgentArchivedAt(workspace.client, archived.id);
    expect(archivedAt).not.toBeNull();

    await mkdir(path.join(directory, "client"));
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `import { Panel } from "./client/panel";
export default function contribute(client) {
  client.addWorkspacePanel({ id: "history", title: "Plugin history", icon: "History", context: "workspace", locations: ["explorer"], Component: Panel });
  client.addCommandCenterItem({ id: "history", title: "Open plugin history", icon: "History", context: "workspace", onSelect({ openPanel }) { openPanel("history", { location: "explorer" }); } });
  return () => {};
}`,
    );
    await writeFile(
      path.join(directory, "client", "panel.tsx"),
      `import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
export function Panel({ workspaceId, navigation, theme }) {
  const [query, setQuery] = useState("");
  return <View testID="archive-navigation-panel">
    <TextInput accessibilityLabel="Plugin history search" value={query} onChangeText={setQuery} style={{ color: theme.colors.foreground }} />
    <Pressable accessibilityRole="button" accessibilityLabel="Open archived conversation" onPress={() => navigation.openAgent({ agentId: ${JSON.stringify(archived.id)}, workspaceId, pin: true })}>
      <Text style={{ color: theme.colors.foreground }}>Open archived conversation</Text>
    </Pressable>
  </View>;
}`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoAppShell(page);
    await page.goto(buildAgentRoute(workspace.workspaceId, active.id));
    await page.waitForURL((url) => url.pathname.includes("/workspace/") && !url.search);
    const commands = await openCommandCenter(page);
    await commands.getByTestId("command-center-input").fill("Open plugin history");
    await commands.getByRole("button", { name: "Open plugin history", exact: true }).click();
    await expect(commands).not.toBeVisible();

    const panel = page.getByTestId("archive-navigation-panel");
    const panelElement = await panel.elementHandle();
    const deck = page.getByTestId(`workspace-deck-entry-${getServerId()}:${workspace.workspaceId}`);
    const deckElement = await deck.elementHandle();
    const search = page.getByRole("textbox", { name: "Plugin history search" });
    await search.fill("preserved search");
    const workspaceUrl = page.url();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.getByRole("button", { name: "Open archived conversation" }).click();
      await expectArchivedAgentFocused(page, archived.id);
      await expect(page).toHaveURL(workspaceUrl);
      await expect(search).toHaveValue("preserved search");
      expect(await panelElement!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await deckElement!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await fetchAgentArchivedAt(workspace.client, archived.id)).toBe(archivedAt);
    }

    const screenshot = testInfo.outputPath("plugin-archived-agent-navigation.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("Archived conversation and preserved Explorer", {
      path: screenshot,
      contentType: "image/png",
    });

    await page.getByRole("button", { name: "Unarchive", exact: true }).click();
    await expect.poll(() => fetchAgentArchivedAt(workspace.client, archived.id)).toBeNull();
    await expect(page.getByText("This agent is archived").filter({ visible: true })).toHaveCount(0);
    await expect(search).toHaveValue("preserved search");
    await expect(page).toHaveURL(workspaceUrl);
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await workspace.cleanup().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
