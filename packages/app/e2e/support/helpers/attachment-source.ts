import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { gotoAppShell } from "./app";
import { expectComposerVisible } from "./composer";
import { clickNewChat } from "./launcher";
import { getE2EDaemonPort } from "./daemon-port";
import { TEST_HOST_LABEL } from "./daemon-registry";
import { connectNewWorkspaceDaemonClient, loadSessionMessageReaders } from "./new-workspace";
import { copyPluginFixture } from "./plugin-fixture";
import { seedWorkspace } from "./seed-client";
import { getServerId } from "./server-id";
import { switchWorkspaceViaSidebar, waitForSidebarHydration } from "./workspace-ui";

const RESULT_TITLE = "Example conversation";
const PLUGIN_ID = "test-attachment-source";
const SOURCE_SEARCH_METHOD = "context.search";
const SNAPSHOT_TEXT = "[User] Example context\n[Assistant] Example response";

const EXPECTED_REMOTE_ATTACHMENT = {
  type: "text",
  mimeType: "text/plain",
  title: expect.stringMatching(/^a1b2c3d4 Example conversation/),
  text: SNAPSHOT_TEXT,
  contextKind: "chat_history",
  externalResource: {
    provider: PLUGIN_ID,
    providerLabel: "Conversation context · Secondary",
    resourceType: "conversation",
    id: "agent_a1b2c3d4-1a2b-3c4d-5e6f-123456789abc",
    identifier: "a1b2c3d4",
    title: expect.stringMatching(/^Example conversation/),
    url: "https://example.invalid/conversation",
  },
};

interface AttachmentSourceActions {
  openShortcut(): Promise<void>;
  expectPickerLabels(viewport: "desktop" | "compact"): Promise<void>;
  attachDefaultResult(): Promise<void>;
  expectAttachmentInDraft(): Promise<void>;
}

export async function observeCrossHostAttachmentTraffic(page: Page, sourcePort: number) {
  const frames = await loadSessionMessageReaders();
  const destinationPort = getE2EDaemonPort();
  let searchRequestCount = 0;
  let submittedAttachment: unknown = null;

  page.on("websocket", (socket) => {
    const socketPort = new URL(socket.url()).port;
    socket.on("framesent", ({ payload }) => {
      const message = frames.client(payload);
      if (
        socketPort === String(sourcePort) &&
        message?.type === "plugin.rpc.invoke.request" &&
        message.pluginId === PLUGIN_ID &&
        message.method === SOURCE_SEARCH_METHOD
      ) {
        searchRequestCount += 1;
      }

      if (socketPort !== destinationPort) return;
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
          attachment.externalResource.provider === PLUGIN_ID,
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
  options?: {
    fixtureName?: string;
    onWorkspaceCreated?: (workspace: { workspaceId: string; repoPath: string }) => void;
  },
): Promise<void> {
  info.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "attachment-source-" });
  const cleanupSteps: Array<() => Promise<unknown>> = [() => workspace.cleanup()];
  let journeyFailed = false;
  let journeyError: unknown;

  try {
    options?.onWorkspaceCreated?.(workspace);
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
      expectPickerLabels: (viewport) =>
        test.step("show the title, workspace, and source host", async () => {
          const result = page.getByRole("button", { name: new RegExp(`^${RESULT_TITLE}`) });
          const title = result.getByText(RESULT_TITLE);
          const workspaceLabel = result.getByText("Example workspace", { exact: true });
          const host = page.getByTestId("plugin-attachment-source-host");
          await expect(result).toBeVisible();
          await expect(result).not.toContainText("a1b2c3d4");
          await expect(host).toHaveText(TEST_HOST_LABEL);
          await expect(host).toBeVisible();
          await expect(workspaceLabel).toBeVisible();
          expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
            true,
          );
          await expect(async () => {
            const [titleBox, workspaceBox] = await Promise.all([
              title.boundingBox(),
              workspaceLabel.boundingBox(),
            ]);
            if (!titleBox || !workspaceBox) throw new Error("Expected both result labels");
            expect(workspaceBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1);
            expect(workspaceBox.x).toBeCloseTo(titleBox.x);
          }).toPass({ timeout: 5_000 });

          const search = page.getByPlaceholder("Search conversations", { exact: true });
          await search.fill("no such conversation");
          await expect(result).toHaveCount(0);
          await search.fill("a1b2c3d4");
          await expect(result).toBeVisible();
          await search.clear();

          const screenshotPath = info.outputPath(`attachment-source-picker-${viewport}.png`);
          await page.screenshot({ path: screenshotPath, animations: "disabled" });
          await info.attach(`attachment-source-picker-${viewport}`, {
            path: screenshotPath,
            contentType: "image/png",
          });
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
