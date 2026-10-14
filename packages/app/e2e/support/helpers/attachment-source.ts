import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { gotoAppShell } from "./app";
import { expectComposerVisible } from "./composer";
import { clickNewChat } from "./launcher";
import { connectNewWorkspaceDaemonClient, loadSessionMessageReaders } from "./new-workspace";
import { copyPluginFixture } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { switchWorkspaceViaSidebar, waitForSidebarHydration } from "./workspace-ui";

const RESULT_TITLE = "Example conversation";
const SOURCE_PLUGIN_ID = "test-attachment-source";
const SOURCE_SEARCH_METHOD = "context.search";
const SNAPSHOT_TEXT = "[User] Example context\n[Assistant] Example response";

const EXPECTED_REMOTE_ATTACHMENT = {
  type: "text",
  mimeType: "text/plain",
  title: "Sample Example conversation",
  text: SNAPSHOT_TEXT,
  contextKind: "chat_history",
  externalResource: {
    provider: SOURCE_PLUGIN_ID,
    providerLabel: "Conversation context · Secondary",
    resourceType: "conversation",
    id: "sample",
    identifier: "Sample",
    title: RESULT_TITLE,
    url: "https://example.invalid/conversation",
  },
};

interface AttachmentSourceActions {
  openShortcut(): Promise<void>;
  attachDefaultResult(): Promise<void>;
  expectAttachmentInDraft(): Promise<void>;
}

export async function observeCrossHostAttachmentTraffic(page: Page, sourcePort: number) {
  const frames = await loadSessionMessageReaders();
  let searchRequestCount = 0;
  let submittedAttachment: unknown = null;

  page.on("websocket", (socket) => {
    const socketPort = new URL(socket.url()).port;
    socket.on("framesent", ({ payload }) => {
      const message = frames.client(payload);
      if (
        socketPort === String(sourcePort) &&
        message?.type === "plugin.rpc.invoke.request" &&
        message.pluginId === SOURCE_PLUGIN_ID &&
        message.method === SOURCE_SEARCH_METHOD
      ) {
        searchRequestCount += 1;
      }

      let attachments: unknown;
      if (message?.type === "workspace.create.request") {
        attachments = message.agent?.attachments;
      } else if (
        message?.type === "create_agent_request" ||
        message?.type === "agent.create.request" ||
        message?.type === "send_agent_message_request"
      ) {
        attachments = message.attachments;
      }
      if (!Array.isArray(attachments)) return;
      submittedAttachment = attachments.find(
        (attachment) =>
          typeof attachment === "object" &&
          attachment !== null &&
          "externalResource" in attachment &&
          typeof attachment.externalResource === "object" &&
          attachment.externalResource !== null &&
          "provider" in attachment.externalResource &&
          attachment.externalResource.provider === SOURCE_PLUGIN_ID,
      );
    });
  });

  return {
    expectSearchNotStarted() {
      expect(searchRequestCount).toBe(0);
    },
    async expectSearchStarted() {
      await expect.poll(() => searchRequestCount).toBeGreaterThan(0);
    },
    async expectSnapshotSubmittedToDestination() {
      await expect.poll(() => submittedAttachment).toMatchObject(EXPECTED_REMOTE_ATTACHMENT);
    },
  };
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
