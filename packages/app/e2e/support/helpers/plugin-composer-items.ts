import { expect, test, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { openAgentRoute } from "./mock-agent";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { copyPluginExample } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";

const PLUGIN_ID = "composer-controls-example";
const NARROW = { width: 500, height: 800 };

/** Runs `run` in an agent's composer with the composer-controls example installed. */
export async function withComposerControlsExample(
  page: Page,
  run: (composer: {
    narrowTheWindow(): Promise<void>;
    openAgentFeatures(): Promise<void>;
    expectFeatureRow(name: string): Promise<void>;
  }) => Promise<void>,
) {
  const workspace = await seedWorkspace({
    repoPrefix: "composer-items-",
    title: "Composer items",
  });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Composer items agent",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const example = await copyPluginExample("composer-controls");
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await gotoAppShell(page);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await run({
      narrowTheWindow: () =>
        test.step("narrow the window until the composer folds its controls away", () =>
          page.setViewportSize(NARROW)),
      openAgentFeatures: () =>
        test.step("open the agent features sheet", async () => {
          await page.getByRole("button", { name: "Open agent features", exact: true }).click();
        }),
      expectFeatureRow: (name) =>
        test.step(`the sheet has a row for "${name}"`, () =>
          expect(page.getByRole("button", { name, exact: true })).toBeVisible()),
    });
  } finally {
    await client.removePlugin(PLUGIN_ID);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await example.cleanup();
    await workspace.cleanup();
  }
}
