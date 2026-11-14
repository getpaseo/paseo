import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { gotoAppShell } from "./app";
import { expectComposerVisible } from "./composer";
import { clickNewChat } from "./launcher";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { copyPluginFixture } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { switchWorkspaceViaSidebar, waitForSidebarHydration } from "./workspace-ui";

const RESULT_TITLE = "Example conversation";
const PLUGIN_ID = "test-attachment-source";

interface AttachmentSourceActions {
  openShortcut(): Promise<void>;
  attachDefaultResult(): Promise<void>;
  expectAttachmentInDraft(): Promise<void>;
}

export async function withAttachmentSourceFixture(
  page: Page,
  info: TestInfo,
  run: (actions: AttachmentSourceActions) => Promise<void>,
  options?: { fixtureName?: string },
): Promise<void> {
  info.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "attachment-source-" });
  const cleanupSteps: Array<() => Promise<unknown>> = [() => workspace.cleanup()];
  let journeyFailed = false;
  let journeyError: unknown;

  try {
    const pluginClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    cleanupSteps.unshift(() => pluginClient.close());
    const previousConfig = await pluginClient.getDaemonConfig();
    const plugin = await copyPluginFixture(options?.fixtureName ?? "attachment-source");
    cleanupSteps.unshift(() => plugin.cleanup());
    cleanupSteps.unshift(() =>
      pluginClient.patchDaemonConfig({
        pluginsEnabled: previousConfig.config.pluginsEnabled ?? false,
      }),
    );
    cleanupSteps.unshift(async () => {
      const source = (await pluginClient.getDaemonConfig()).config.plugins?.[PLUGIN_ID];
      if (source?.path === plugin.directory) await pluginClient.removePlugin(PLUGIN_ID);
    });
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
      openShortcut: () =>
        test.step("open the attachment source from the New Agent draft", async () => {
          const shortcut = page.getByRole("button", {
            name: "Attach Conversation context",
            exact: true,
          });
          await expect(shortcut).toBeVisible({ timeout: 30_000 });
          await shortcut.click();
          await expect(
            page.getByPlaceholder("Search conversations", { exact: true }),
          ).toBeVisible();
        }),
      attachDefaultResult: () =>
        test.step("select the default result without typing a query", async () => {
          const result = page.getByRole("button", { name: new RegExp(RESULT_TITLE) });
          await expect(result).toBeVisible({ timeout: 30_000 });
          await result.click();
        }),
      expectAttachmentInDraft: () =>
        test.step("retain the selected chat-history attachment in the draft", async () => {
          await expect(page.getByTestId("composer-plugin-resource-attachment-pill")).toContainText(
            RESULT_TITLE,
          );
          const screenshotPath = info.outputPath("attachment-source-new-agent.png");
          await page.screenshot({ path: screenshotPath, animations: "disabled" });
          await info.attach("attachment-source-new-agent", {
            path: screenshotPath,
            contentType: "image/png",
          });
        }),
    });
  } catch (error) {
    journeyFailed = true;
    journeyError = error;
  }
  const errors: unknown[] = [];
  for (const cleanup of cleanupSteps) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    const teardownError = new AggregateError(errors, "Attachment source fixture teardown failed");
    if (journeyFailed) {
      console.error(teardownError);
    } else {
      throw teardownError;
    }
  }
  if (journeyFailed) throw journeyError;
}
