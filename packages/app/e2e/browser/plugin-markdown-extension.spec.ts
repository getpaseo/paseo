import { expect, test } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";

const PLUGIN_ID = "markdown-extension";

// A backslash and an underscore: markdown-it's escape rule eats the backslash when the
// extension is gone, so this is how we tell host rendering from the extension's leaf token.
const INLINE_SOURCE = "::a\\_b::";
const INLINE_LINE = `Inline ${INLINE_SOURCE} renders as a badge.`;
// A `:::` block with no closing fence is what a still-streaming block looks like. Without the
// extension's declared delimiter the splitter cuts it at the blank line and the block rule only
// ever sees "still".
const BLOCK_SOURCE = ":::\nstill\n\nstreaming";
const RESPONSE = `${INLINE_LINE}\n\n${BLOCK_SOURCE}`;

test("renders assistant markdown through an installed extension", async ({ page }) => {
  const example = await copyPluginExample(PLUGIN_ID);
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "plugin-markdown-extension-",
    title: "Markdown extension",
    initialPrompt: "Render the configured markdown response.",
    featureValues: { mockAssistantResponse: RESPONSE },
  });

  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);

    const assistantMessage = page.getByTestId("assistant-message").last();
    await expect(assistantMessage).toBeVisible({ timeout: 30_000 });

    await test.step("the extension's parser and rules render through the assistant message", async () => {
      await expect(assistantMessage).toContainText("[a\\_b]", { timeout: 30_000 });
      await expect(assistantMessage).toContainText("renders as a badge.");
      await expect(assistantMessage).not.toContainText(INLINE_SOURCE);
      await expect(assistantMessage).not.toContainText(":::");
    });

    await test.step("a declared block delimiter keeps an unclosed block in one render token", async () => {
      // The block rule sets accessibilityLabel to the inner content. Without blockDelimiters
      // the splitter cuts at the blank line and the label is only "still".
      await expect(assistantMessage.getByLabel("still\n\nstreaming")).toBeVisible();
    });

    await test.step("removing the plugin restores the built-in rendering", async () => {
      await client.removePlugin(PLUGIN_ID);
      // markdown-it's own escape rule eats the backslash once the extension no longer claims
      // the run — the built-in rendering, restored.
      await expect(assistantMessage).toContainText("::a_b::", { timeout: 30_000 });
      await expect(assistantMessage).toContainText(":::");
    });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await agent.cleanup().catch(() => undefined);
    await example.cleanup();
  }
});
