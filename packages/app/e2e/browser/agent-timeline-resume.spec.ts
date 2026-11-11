import { test } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  expectTimelinePresentationUnchanged,
  expectTimelinePromptNotMounted,
  expectTimelinePromptVisible,
  openAgentTimeline,
  rememberTimelinePresentation,
  scrollTimelinePromptIntoView,
  scrollTimelineUntilOlderHistoryIsReachable,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";
import {
  commitTimelineTurnsWhileDisconnected,
  disconnectViewedTimeline,
  expectOneResumeCheckWithoutTail,
  expectResumeOverflowFallsBackToOneTail,
  rememberTimelineRequestCounts,
  restoreViewedTimelineWithHeldResponse,
} from "../support/helpers/timeline-resume";

test.describe("Agent timeline resume", () => {
  test("a long disconnected run lands as one latest-tail update", async ({ page }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const agent = await seedLongMockAgentTimeline({ turns: 3 });
    try {
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      const requests = rememberTimelineRequestCounts(gate);
      await disconnectViewedTimeline(page, gate);
      const background = await commitTimelineTurnsWhileDisconnected(agent, 24);
      await restoreViewedTimelineWithHeldResponse(page, gate);

      await expectTimelinePromptVisible(page, background.newestPrompt);
      await expectTimelinePromptNotMounted(page, background.firstPrompt);
      expectResumeOverflowFallsBackToOneTail(gate, requests);
      await scrollTimelineUntilOlderHistoryIsReachable(page, background.firstPrompt);
    } finally {
      gate.restore();
      await agent.cleanup();
    }
  });

  test("an unchanged resume leaves a scrolled-up timeline untouched", async ({ page }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const agent = await seedLongMockAgentTimeline({ turns: 30 });
    try {
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await scrollTimelinePromptIntoView(page, agent.initialTailAnchorPrompt);
      const presentation = await rememberTimelinePresentation(page, agent.initialTailAnchorPrompt);
      const requests = rememberTimelineRequestCounts(gate);

      await disconnectViewedTimeline(page, gate);
      await restoreViewedTimelineWithHeldResponse(page, gate);

      await expectTimelinePresentationUnchanged(page, presentation);
      expectOneResumeCheckWithoutTail(gate, requests);
    } finally {
      gate.restore();
      await agent.cleanup();
    }
  });
});
