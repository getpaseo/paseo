import { test } from "./fixtures";
import {
  expectLoadedTimelineDoesNotScroll,
  expectTimelinePromptNotMounted,
  expectTimelinePromptVisible,
  holdNextOlderTimelinePage,
  makeLoadedTimelineFitViewport,
  openAgentTimeline,
  scrollTimelineUntilOlderHistoryIsReachable,
  seedLongMockAgentTimeline,
} from "./helpers/timeline-pagination";

test.describe("Agent timeline pagination", () => {
  test("loads older history when the user scrolls to the top of a long agent timeline", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);

      await scrollTimelineUntilOlderHistoryIsReachable(page);

      await expectTimelinePromptVisible(page, agent.oldestPrompt);
    } finally {
      await agent.cleanup();
    }
  });

  test("loads older history when the initial page does not fill the viewport", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 30 });
    try {
      await makeLoadedTimelineFitViewport(page);
      const olderPage = await holdNextOlderTimelinePage(page, agent);
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await expectLoadedTimelineDoesNotScroll(page);
      await olderPage.expectLoading();
      olderPage.release();
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
    } finally {
      await agent.cleanup();
    }
  });
});
