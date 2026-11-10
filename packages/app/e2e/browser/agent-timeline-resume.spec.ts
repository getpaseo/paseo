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
  answerFreshnessCheck,
  commitTimelineTurnsWhileDisconnected,
  disconnectViewedTimeline,
  expectResumeAnsweredWithoutFetch,
  expectResumeOverflowFallsBackToOneTail,
  hideTabAndReturn,
  rememberTimelineRequestCounts,
  releaseHeldCatchUp,
  restoreUnchangedViewedTimeline,
  restoreViewedTimelineHoldingCatchUp,
  restoreViewedTimelineWithHeldResponse,
  returnWithFreshnessCheckUnanswered,
  waitForResumeAnswer,
  reopenAppWatchingForUpdatingToast,
  watchForUpdatingToast,
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

  test("returning to an unchanged chat shows no update and leaves it untouched", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const agent = await seedLongMockAgentTimeline({ turns: 30 });
    try {
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      await scrollTimelinePromptIntoView(page, agent.initialTailAnchorPrompt);
      const presentation = await rememberTimelinePresentation(page, agent.initialTailAnchorPrompt);

      await test.step("back from the background", async () => {
        const requests = rememberTimelineRequestCounts(gate);
        const expectNoUpdatingToast = await watchForUpdatingToast(page);

        await hideTabAndReturn(page);
        await waitForResumeAnswer(gate, requests);

        await expectNoUpdatingToast();
        await expectTimelinePresentationUnchanged(page, presentation);
        expectResumeAnsweredWithoutFetch(gate, requests);
      });

      await test.step("back from a dropped connection", async () => {
        const requests = rememberTimelineRequestCounts(gate);
        const expectNoUpdatingToast = await watchForUpdatingToast(page);

        await disconnectViewedTimeline(page, gate);
        await restoreUnchangedViewedTimeline(page, gate);

        await expectNoUpdatingToast();
        await expectTimelinePresentationUnchanged(page, presentation);
        expectResumeAnsweredWithoutFetch(gate, requests);
      });

      await test.step("back from reopening the app", async () => {
        const requests = rememberTimelineRequestCounts(gate);

        const expectNoUpdatingToast = await reopenAppWatchingForUpdatingToast(page);
        await waitForResumeAnswer(gate, requests);
        await expectTimelinePromptVisible(page, agent.newestPrompt);

        await expectNoUpdatingToast();
        expectResumeAnsweredWithoutFetch(gate, requests);
      });
    } finally {
      gate.restore();
      await agent.cleanup();
    }
  });

  test("a check the daemon has not answered reports the update until it does", async ({ page }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const agent = await seedLongMockAgentTimeline({ turns: 3 });
    try {
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      const requests = rememberTimelineRequestCounts(gate);

      await returnWithFreshnessCheckUnanswered(page, gate);
      await answerFreshnessCheck(page, gate);

      expectResumeAnsweredWithoutFetch(gate, requests);
    } finally {
      gate.restore();
      await agent.cleanup();
    }
  });

  test("returning to a changed chat reports the update and shows the new messages", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const agent = await seedLongMockAgentTimeline({ turns: 3 });
    try {
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      const presentation = await rememberTimelinePresentation(page, agent.newestPrompt);

      await disconnectViewedTimeline(page, gate);
      const background = await commitTimelineTurnsWhileDisconnected(agent, 1);
      await restoreViewedTimelineHoldingCatchUp(page, gate);

      await expectTimelinePresentationUnchanged(page, presentation);
      await releaseHeldCatchUp(page, gate);
      await expectTimelinePromptVisible(page, background.newestPrompt);
    } finally {
      gate.restore();
      await agent.cleanup();
    }
  });
});
