import { dropNextForkRequest, observeForkAttachment } from "../support/helpers/assistant-fork";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { expect, test } from "../support/fixtures";
import {
  withTimelinePlugin,
  viewInlineThinkingExample,
  requestPluginTimeline,
  interactWithStreamingCard,
  expectWholeCompletedCard,
  expectBothConsecutiveTools,
  forkCompletedPluginReply,
  expectPluginReplyForkHidden,
  expectPluginReplyForkAvailable,
  attemptDroppedPluginReplyForkAndWaitForRecovery,
  ASSISTANT_TEXT,
  trackPluginChatRecovery,
  reconnectPluginChat,
} from "../support/helpers/plugin-timeline";

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: Object.fromEntries(
        [
          "claude",
          "codex",
          "copilot",
          "opencode",
          "pi",
          "omp",
          "antigravity",
          "hoplite",
          "muse",
        ].map((id) => [id, { enabled: false }]),
      ),
    },
  },
});

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

for (const target of ["tab", "workspace"] as const) {
  test(`forks a transformed reply into a new ${target}`, async ({ page }, info) => {
    const width = target === "tab" ? 1100 : 390;
    await page.setViewportSize({ width, height: 900 });
    const attachment = observeForkAttachment(page);
    await withTimelinePlugin(page, info, "assistant", async (agent) => {
      await requestPluginTimeline(agent);
      await interactWithStreamingCard(page);
      await expectPluginReplyForkHidden(page);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectWholeCompletedCard(page);
      await forkCompletedPluginReply(page, info, target);
      expect(await attachment.waitForText()).toContain(ASSISTANT_TEXT);
      await openAgentRoute(page, agent);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expectWholeCompletedCard(page);
      await expectPluginReplyForkAvailable(page);
    });
  });
}

test("a transformed reply can fork again after a request times out", async ({ page }, info) => {
  const dropped = await dropNextForkRequest(page);
  const attachment = observeForkAttachment(page);
  await withTimelinePlugin(page, info, "assistant", async (agent) => {
    await requestPluginTimeline(agent);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectWholeCompletedCard(page);
    await attemptDroppedPluginReplyForkAndWaitForRecovery(page, dropped);
    await expectWholeCompletedCard(page);
    await forkCompletedPluginReply(page, info, "tab");
    expect(await attachment.waitForText()).toContain(ASSISTANT_TEXT);
  });
});

test("inline-thinking example renders a streamed thought through host UI", async ({
  page,
}, info) => {
  await viewInlineThinkingExample(page, info);
});
