import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { gotoAppShell } from "./app";
import { expectComposerVisible } from "./composer";
import { clickNewChat } from "./launcher";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { copyPluginExample } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { switchWorkspaceViaSidebar, waitForSidebarHydration } from "./workspace-ui";

const SOURCE_TITLE = "Recent context source";

interface AgentContextActions {
  openPickerFromNewAgent(): Promise<void>;
  attachRecentSource(): Promise<void>;
  expectAttachmentInDraft(): Promise<void>;
}

export async function withAgentContextExample(
  page: Page,
  info: TestInfo,
  run: (actions: AgentContextActions) => Promise<void>,
): Promise<void> {
  info.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "agent-context-attachment-" });
  const pluginClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await pluginClient.getDaemonConfig();
  const plugin = await copyPluginExample("agent-context");

  try {
    const sourceAgent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: SOURCE_TITLE,
      modeId: "load-test",
      model: "e2e-fast-stream",
      initialPrompt: "Create context for the next agent.",
    });
    await workspace.client.waitForFinish(sourceAgent.id, 15_000);
    await pluginClient.patchDaemonConfig({ pluginsEnabled: true });
    await pluginClient.installDirectoryPlugin(plugin.directory);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await clickNewChat(page);
    await expectComposerVisible(page);

    await run({
      openPickerFromNewAgent: () =>
        test.step("open the transcript picker from the New Agent draft", async () => {
          const shortcut = page.getByRole("button", {
            name: "Attach agent transcript",
            exact: true,
          });
          await expect(shortcut).toBeVisible({ timeout: 30_000 });
          await shortcut.click();
          await expect(page.getByPlaceholder("Search agents", { exact: true })).toBeVisible();
        }),
      attachRecentSource: () =>
        test.step("select a recent agent without typing a query", async () => {
          const recentAgent = page.getByRole("button", { name: new RegExp(SOURCE_TITLE) });
          await expect(recentAgent).toBeVisible({ timeout: 30_000 });
          await recentAgent.click();
        }),
      expectAttachmentInDraft: () =>
        test.step("retain the selected snapshot in the draft", async () => {
          await expect(
            page.getByTestId("composer-plugin-resource-attachment-pill"),
          ).toContainText(SOURCE_TITLE);
          await info.attach("agent-context-new-agent", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        }),
    });
  } finally {
    const cleanupSteps: Array<() => Promise<unknown>> = [
      () => pluginClient.removePlugin("agent-context"),
      () =>
        pluginClient.patchDaemonConfig({
          pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
        }),
      () => pluginClient.close(),
      () => plugin.cleanup(),
      () => workspace.cleanup(),
    ];
    const errors: unknown[] = [];
    for (const cleanup of cleanupSteps) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Agent context fixture teardown failed");
    }
  }
}
