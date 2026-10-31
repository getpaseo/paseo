import type { WebSocketRoute } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
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
      gate.holdTimelineResponses(agent.agentId);
      await page.reload({ waitUntil: "domcontentloaded" });
      await gate.waitForHeldTimelineResponse();
      await recovery.expectCatalogWithoutRetransmission();
      gate.releaseHeldTimelineResponses();
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

test("reopens transformed timeline from the cached catalog before network refresh", async ({
  page,
}, info) => {
  let delayCatalog = false;
  const held: Array<{ browser: WebSocketRoute; message: string }> = [];
  const logs: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") logs.push(message.text());
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (
        typeof message === "string" &&
        delayCatalog &&
        JSON.parse(message).message?.type === "plugin.catalog.get.response"
      ) {
        held.push({ browser, message });
      } else browser.send(message);
    });
  });
  try {
    await withTimelinePlugin(page, info, "assistant", async (agent) => {
      await requestPluginTimeline(agent);
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectWholeCompletedCard(page);
      delayCatalog = true;
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(() => held.length).toBeGreaterThan(0);
        await expect(
          page.getByRole("heading", { name: /^Assistant (streaming|complete)$/ }),
        ).toBeVisible();
        await expect(page.getByTestId("assistant-message")).toHaveCount(0);
        await info.attach("cached-catalog-before-network", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      } finally {
        delayCatalog = false;
        for (const { browser, message } of held.splice(0)) browser.send(message);
      }
      await expect(
        page.getByRole("heading", { name: /^Assistant (streaming|complete)$/ }),
      ).toBeVisible();
    });
  } finally {
    await info.attach("catalog-cache-browser-warnings", {
      body: logs.join("\n"),
      contentType: "text/plain",
    });
  }
});
