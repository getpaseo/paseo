import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import {
  expectChatHistoryAttachment,
  forkMostRecentAssistantTurnToNewTab,
  observeForkAttachment,
} from "../support/helpers/assistant-fork";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { expectFileTabOpen } from "../support/helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  ASSISTANT_TEXT,
  withDirectoryPlugin,
  withTimelinePlugin,
  viewInlineThinkingExample,
  requestPluginTimeline,
  interactWithStreamingCard,
  expectWholeCompletedCard,
  expectBothConsecutiveTools,
  trackPluginChatRecovery,
  reconnectPluginChat,
} from "../support/helpers/plugin-timeline";

for (const width of [1100, 390]) {
  test(`assistant plugin receives the whole streaming message at width ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const gate = await installDaemonWebSocketGate(page);
    await withTimelinePlugin(page, info, "assistant", async (agent) => {
      await requestPluginTimeline(agent);
      await interactWithStreamingCard(page);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectWholeCompletedCard(page);
      // Local state is checked during growth; the viewport remounts on the history handoff.
      const recovery = trackPluginChatRecovery(page);
      // A chat with a cached cursor answers current and never fetches, so hold the subscribe itself.
      gate.holdNextClientRequest("agent.timeline.set_subscription.request");
      await page.reload({ waitUntil: "domcontentloaded" });
      await gate.waitForHeldClientRequest();
      await recovery.expectCatalogWithoutRetransmission();
      gate.releaseHeldClientRequest();
      await expectWholeCompletedCard(page);
      await recovery.expectRecoveredWithoutRetransmission();
      recovery.reset();
      await reconnectPluginChat(page, gate);
      await recovery.expectRecoveredWithoutRetransmission();
      await expectWholeCompletedCard(page);
    });
  });
}

test("Overview preserves both consecutive tool plugin cards", async ({ page }, info) => {
  await withTimelinePlugin(page, info, "tools", async (agent) => {
    await requestPluginTimeline(agent);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectBothConsecutiveTools(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectBothConsecutiveTools(page);
  });
});

test("inline-thinking example renders a streamed thought through host UI", async ({
  page,
}, info) => {
  await viewInlineThinkingExample(page, info);
});

test("plugin-transformed assistant reply keeps copy, fork, and turn duration in its footer", async ({
  page,
}, info) => {
  const forkAttachment = observeForkAttachment(page);
  await withTimelinePlugin(page, info, "assistant", async (agent) => {
    await requestPluginTimeline(agent);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectWholeCompletedCard(page);

    const footer = page.getByTestId("turn-footer").last();
    await expect(footer).toBeVisible();
    await expect(footer.getByRole("button", { name: "Copy turn" })).toBeVisible();
    await expect(footer.getByRole("button", { name: "Fork chat from here" })).toBeVisible();
    await expect(footer.getByText(/^Worked for /)).toBeVisible();

    await forkMostRecentAssistantTurnToNewTab(page);
    await expectChatHistoryAttachment(page);
    expect(await forkAttachment.waitForText()).toContain(ASSISTANT_TEXT);
  });
});

test("timeline renderer opens a workspace file in the stream's file pane", async ({ page }) => {
  const openFileSource = `import React from "react";
import { Pressable, Text } from "react-native";
import { z } from "zod";

function FileCard({ openFile }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!openFile}
      onPress={() => openFile?.({ path: "docs/report.md", lineStart: 2, lineEnd: 3 })}
    >
      <Text>Open timeline file</Text>
    </Pressable>
  );
}

export default function contribute(client) {
  client.addTimelineTransformer({
    id: "open-file",
    query: { itemType: "assistant_message" },
    transform({ phase }) {
      if (phase !== "complete") return undefined;
      return { items: [{ type: "plugin", kind: "open-file-card", version: 1, data: { ready: true } }] };
    },
  });
  client.addTimelineRenderer({
    kind: "open-file-card",
    version: 1,
    schema: z.object({ ready: z.boolean() }),
    Component: FileCard,
  });
  return () => {};
}`;

  const agent = await seedMockAgentWorkspace({
    repoPrefix: "timeline-open-file-",
    title: "Timeline open file",
  });
  try {
    await mkdir(path.join(agent.cwd, "docs"), { recursive: true });
    await writeFile(
      path.join(agent.cwd, "docs/report.md"),
      "Line 1\nTarget timeline line\nLine 3\n",
    );
    await withDirectoryPlugin({
      pluginId: "timeline-open-file-e2e",
      source: openFileSource,
      run: async () => {
        await openAgentRoute(page, agent);
        await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible();
        await requestPluginTimeline(agent);
        await agent.client.waitForFinish(agent.agentId, 30_000);
        const button = page.getByRole("button", { name: "Open timeline file", exact: true });
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
        await button.click();
        await expectFileTabOpen(page, "docs/report.md");
        await expect(page.getByText("Target timeline line", { exact: false })).toBeVisible();
      },
    });
  } finally {
    await agent.cleanup();
  }
});
