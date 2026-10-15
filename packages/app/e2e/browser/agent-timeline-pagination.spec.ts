import { expect, test } from "../support/fixtures";
import {
  withSpokenTimeline,
  captureSpokenTimeline,
  reloadSpokenTimeline,
  expectSpokenTimelinePrompt,
  sendSpokenTimelinePrompt,
  expectStableHistoryStartGutter,
  expectTimelineAtHistoryStart,
  expectTimelinePromptCentered,
  expectTimelinePromptNotMounted,
  expectTimelinePromptPositionPreserved,
  expectTimelinePromptVisible,
  holdBootstrapTimelinePage,
  holdDaemonHydration,
  holdOlderHistoryPages,
  makeLoadedTimelineFitViewport,
  openAgentTimeline,
  rememberTimelineViewport,
  rememberTimelinePromptPosition,
  reloadAgentTimelineFromPersistedReplica,
  scrollTimelineUntilOlderHistoryIsReachable,
  scrollTimelineToOldestLoadedEdge,
  scrollTimelineToNewestLoadedEdge,
  seedLongMockAgentTimeline,
  scrollThroughOlderHistoryPages,
  seedRealisticOlderTimeline,
  sendLiveTurnBeforeHydration,
  expectTimelineViewportAnchoredAfterPrepend,
  userNavigatesTimelineToHistoryStartWithKeyboard,
  userScrollsTimelineToHistoryStart,
} from "../support/helpers/timeline-pagination";

test.describe("Agent timeline pagination", () => {
  test("shows spoken words without voice instructions in history, live updates and after reload", async ({
    page,
  }, testInfo) => {
    const historyText = "Please check the voice history.";
    const liveText = "Now check the live voice message.";
    await withSpokenTimeline(historyText, async (agent) => {
      await openAgentTimeline(page, agent);
      await expectSpokenTimelinePrompt(page, historyText);
      await sendSpokenTimelinePrompt(agent, liveText);
      await expectSpokenTimelinePrompt(page, liveText);
      await captureSpokenTimeline(page, testInfo, "desktop");
      await reloadSpokenTimeline(page);
      await expectSpokenTimelinePrompt(page, liveText);
      await captureSpokenTimeline(page, testInfo, "compact");
      await expectSpokenTimelinePrompt(page, liveText);
    });
  });

  test("keeps the history-start gutter and visible position stable through the final page", async ({
    page,
  }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 40 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectStableHistoryStartGutter(page);

      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);
      await expectStableHistoryStartGutter(page);
      const viewport = await rememberTimelineViewport(page);

      history.releasePage(1);
      await expectTimelineViewportAnchoredAfterPrepend(page, viewport);
      await history.expectSettledWithRequestedPages(1);
      await expectStableHistoryStartGutter(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("loads one page each time the user returns to history start", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await expectTimelinePromptCentered(page, agent.newestPrompt);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);
      await expectTimelinePromptNotMounted(page, agent.initialTailOldestPrompt);

      await userScrollsTimelineToHistoryStart(page);
      await expectTimelinePromptVisible(page, agent.initialTailOldestPrompt);
      await history.expectRequestedPages(1);
      const viewport = await rememberTimelineViewport(page);
      history.releasePage(1);
      await expectTimelineViewportAnchoredAfterPrepend(page, viewport);
      await history.expectSettledWithRequestedPages(1);

      await userScrollsTimelineToHistoryStart(page);
      await expectTimelinePromptCentered(page, agent.firstOlderPagePrompt);
      await history.expectRequestedPages(2);
    } finally {
      await agent.cleanup();
    }
  });

  test("loads older history when the user navigates to history start with the keyboard", async ({
    page,
  }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 40 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);

      await userNavigatesTimelineToHistoryStartWithKeyboard(page);
      await history.expectRequestedPages(1);
    } finally {
      await agent.cleanup();
    }
  });

  test("does not repeat an assistant block that spans older history pages", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedRealisticOlderTimeline();
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);

      await scrollThroughOlderHistoryPages(page, 3, history);
      history.expectNoRepeatedEntries();
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps visible history anchored when live output grows during a prepend", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);
      const position = await rememberTimelinePromptPosition(page, agent.initialTailOldestPrompt);

      await agent.client.sendAgentMessage(
        agent.agentId,
        "timeline live during held older page: emit 20 coalesced agent stream updates",
      );
      await agent.client.waitForFinish(agent.agentId, 15_000);
      history.releasePage(1);

      await expectTimelinePromptPositionPreserved(page, position);
    } finally {
      await agent.cleanup();
    }
  });

  test("finishes loading an older page while live output continues", async ({ page }) => {
    test.setTimeout(120_000);
    // The live turn streams for thirty minutes, so it is still running at every assertion.
    const agent = await seedLongMockAgentTimeline({ turns: 40, liveTurns: "thirty-minute-stream" });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);

      await agent.client.sendAgentMessage(agent.agentId, "keep streaming while history settles");
      await agent.client.waitForAgentUpsert(
        agent.agentId,
        (snapshot) => snapshot.status === "running",
      );
      const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
      await expect(timeline.getByText("walking through").first()).toBeAttached();
      history.releasePage(1);

      await expect(timeline.getByText(agent.newestOlderPagePrompt, { exact: true })).toBeAttached();
      await expect(page.getByTestId("load-older-history-spinner")).toBeHidden({ timeout: 5_000 });
      const running = await agent.client.fetchAgents({ scope: "active" });
      expect(running.entries.find((entry) => entry.agent.id === agent.agentId)?.agent.status).toBe(
        "running",
      );
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps loading while older pages still leave history start exposed", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await makeLoadedTimelineFitViewport(page);
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await scrollTimelineToOldestLoadedEdge(page);
      await history.expectRequestedPages(1);
      await expect(page.getByTestId("load-older-history-spinner")).toBeVisible();

      history.releasePage(1);
      await history.expectRequestedPages(2);
      await expectTimelineAtHistoryStart(page);
      await expect(page.getByTestId("load-older-history-spinner")).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps complete loaded history reachable after reload", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await openAgentTimeline(page, agent);
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);
      await expectTimelinePromptVisible(page, agent.oldestPrompt);

      const hydration = await holdDaemonHydration(page);
      await reloadAgentTimelineFromPersistedReplica(page, agent);
      hydration.release();
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);

      await expectTimelinePromptVisible(page, agent.oldestPrompt);
    } finally {
      await agent.cleanup();
    }
  });

  test("preserves a live row received before replica hydration", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await openAgentTimeline(page, agent);
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);

      const hydration = await holdBootstrapTimelinePage(page, agent);
      await reloadAgentTimelineFromPersistedReplica(page, agent);
      await hydration.waitForDelayedResponse();
      const livePrompt = await sendLiveTurnBeforeHydration(agent);
      await expectTimelinePromptVisible(page, livePrompt);

      hydration.release();
      await hydration.waitForDelayedCatchUp();
      await expectTimelinePromptVisible(page, livePrompt);
      hydration.releaseCatchUp();
      await scrollTimelineUntilOlderHistoryIsReachable(page, agent.oldestPrompt);
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
      await scrollTimelineToNewestLoadedEdge(page);
      await expectTimelinePromptVisible(page, livePrompt);
    } finally {
      await agent.cleanup();
    }
  });
});
