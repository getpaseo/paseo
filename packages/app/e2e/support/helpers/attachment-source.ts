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

interface AttachmentSourceActions {
  openShortcut(): Promise<void>;
  attachDefaultResult(): Promise<void>;
  expectAttachmentInDraft(): Promise<void>;
}

export async function withAttachmentSourceFixture(
  page: Page,
  info: TestInfo,
  run: (actions: AttachmentSourceActions) => Promise<void>,
): Promise<void> {
  info.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "attachment-source-" });
  const pluginClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await pluginClient.getDaemonConfig();
  const plugin = await copyPluginFixture("attachment-source");
  let journeyFailed = false;
  let journeyError: unknown;

  try {
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
  const cleanupSteps: Array<() => Promise<unknown>> = [
    () => pluginClient.removePlugin("test-attachment-source"),
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
    const teardownError = new AggregateError(errors, "Attachment source fixture teardown failed");
    if (journeyFailed) {
      console.error(teardownError);
    } else {
      throw teardownError;
    }
  }
  if (journeyFailed) throw journeyError;
}
