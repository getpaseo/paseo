import { test, expect } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  withTimelinePlugin,
  viewInlineThinkingExample,
  requestPluginTimeline,
  interactWithStreamingCard,
  expectWholeCompletedCard,
  expectBothConsecutiveTools,
  trackPluginChatRecovery,
  trackTimelineNativeRowSamples,
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

test("holds cached source rows until a delayed plugin catalog arrives", async ({ page }, info) => {
  const gate = await installDaemonWebSocketGate(page);
  const nativeRows = await trackTimelineNativeRowSamples(page);
  await withTimelinePlugin(page, info, "assistant", async (agent) => {
    await requestPluginTimeline(agent);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expectWholeCompletedCard(page);
    gate.holdPluginCatalogResponses();
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => gate.hasHeldPluginCatalogResponse()).toBe(true);
      await page.waitForTimeout(1000);
      await info.attach("catalog-delayed", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await nativeRows.expectNoSourceRowsAppeared(info);
    } finally {
      gate.releaseHeldPluginCatalogResponses();
    }
    await expect(
      page.getByRole("heading", { name: /^Assistant (streaming|complete)$/ }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Card clicks 0", exact: true })).toBeVisible();
    await expect(page.getByTestId("assistant-message")).toHaveCount(0);
    await info.attach("catalog-released", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});
