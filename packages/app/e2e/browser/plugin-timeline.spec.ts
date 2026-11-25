import { expect, test } from "../support/fixtures";
import {
  expectChatHistoryAttachment,
  forkMostRecentAssistantTurnToNewTab,
  observeForkAttachment,
} from "../support/helpers/assistant-fork";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  ASSISTANT_TEXT,
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
