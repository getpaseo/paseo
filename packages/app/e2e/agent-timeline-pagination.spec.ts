import { test } from "./fixtures";
import {
  expectSameOlderHistoryLoadingOperation,
  expectTimelineAtHistoryStart,
  expectTimelinePromptNotMounted,
  expectTimelinePromptVisible,
  holdBootstrapTimelinePage,
  holdDaemonHydration,
  holdOlderHistoryPages,
  makeLoadedTimelineFitViewport,
  openAgentTimeline,
  rememberOlderHistoryLoadingOperation,
  rememberTimelineViewport,
  reloadAgentTimelineFromPersistedReplica,
  scrollTimelineUntilOlderHistoryIsReachable,
  scrollTimelineToNewestLoadedEdge,
  seedLongMockAgentTimeline,
  sendLiveTurnBeforeHydration,
  expectTimelineViewportAnchoredAfterPrepend,
  userScrollsTimelineToHistoryStart,
} from "./helpers/timeline-pagination";

test.describe("Agent timeline pagination", () => {
  test("loads one page each time the user returns to history start", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);

      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);
      history.releasePage(1);
      await history.expectSettledWithRequestedPages(1);

      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(2);
    } finally {
      await agent.cleanup();
    }
  });

  test("keeps the visible timeline position anchored while prepending a page", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await userScrollsTimelineToHistoryStart(page);
      await history.expectRequestedPages(1);
      const viewport = await rememberTimelineViewport(page);

      history.releasePage(1);
      await expectTimelineViewportAnchoredAfterPrepend(page, viewport);
    } finally {
      await agent.cleanup();
    }
  });

  test("continues one loading operation while older pages still leave history start exposed", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await makeLoadedTimelineFitViewport(page);
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await history.expectRequestedPages(1);
      const loading = await rememberOlderHistoryLoadingOperation(page);

      history.releasePage(1);
      await history.expectRequestedPages(2);
      await expectTimelineAtHistoryStart(page);
      await expectSameOlderHistoryLoadingOperation(page, loading);
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
