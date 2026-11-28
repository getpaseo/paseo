import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { openSubagentFromCompactTrack, seedSubagent } from "../support/helpers/subagents";
import { closeSheet, sheet } from "../support/helpers/sheet";

const PLUGIN_ID = "composer-sections-e2e";
const SOURCE = `import { Pressable, Text, View } from "react-native";
import { useState } from "react";
export default function contribute(client) {
  client.addComposerSection({ id: "visible", Component: ({ agentId, theme }) => {
    const [hidden, setHidden] = useState(false);
    if (hidden) return null;
    return <View testID={"suggestions-" + agentId} style={{ height: 110 }}>
      <Text style={{ color: theme.colors.foreground }}>Suggested replies</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Hide suggestions" onPress={() => setHidden(true)}><Text style={{ color: theme.colors.foreground }}>Hide suggestions</Text></Pressable>
    </View>;
  }});
  client.addComposerSection({ id: "empty", Component: () => null });
  return () => {};
}`;

for (const width of [1200, 390]) {
  test(`composer sections stay below tracks and out of sheets at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 844 });
    const workspace = await seedMockAgentWorkspace({
      repoPrefix: "composer-sections-",
      title: "Sections",
    });
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    const directory = await mkdtemp(path.join(tmpdir(), PLUGIN_ID));
    try {
      await writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
      );
      await writeFile(path.join(directory, "index.client.tsx"), SOURCE);
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(directory);
      const child = await seedSubagent(
        { client: workspace.client, repoPath: workspace.cwd, workspaceId: workspace.workspaceId },
        { parentId: workspace.agentId, title: "Section child" },
      );
      await openAgentRoute(page, {
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
      });
      const section = page.getByTestId(`suggestions-${workspace.agentId}`);
      await expect(section).toBeVisible();
      const tracks = page.getByTestId("composer-track-scroll").filter({ visible: true }).first();
      await expect(tracks).toBeVisible();
      await expect
        .poll(async () => {
          const [trackBox, sectionBox] = await Promise.all([
            tracks.boundingBox(),
            section.boundingBox(),
          ]);
          return trackBox && sectionBox ? trackBox.y + trackBox.height <= sectionBox.y : false;
        })
        .toBe(true);
      if (width === 390) {
        await openSubagentFromCompactTrack(page, child.id);
        const preview = sheet(page, child.title);
        await expect(preview).toBeVisible();
        await expect(preview.getByTestId(`suggestions-${child.id}`)).toHaveCount(0);
        await expect(preview.getByTestId("composer-track-scroll")).toHaveCount(1);
        await closeSheet(page, child.title);
      }
      const transcript = page
        .getByTestId("agent-transcript-tracks")
        .filter({ visible: true })
        .first();
      const before = await transcript.boundingBox();
      await section.getByRole("button", { name: "Hide suggestions", exact: true }).click();
      await expect(section).toHaveCount(0);
      await expect
        .poll(async () => {
          const after = await transcript.boundingBox();
          return before && after ? after.height - before.height : 0;
        })
        .toBeGreaterThanOrEqual(109);
    } finally {
      await client.removePlugin(PLUGIN_ID);
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
      await client.close();
      await rm(directory, { recursive: true, force: true });
      await workspace.cleanup();
    }
  });
}
