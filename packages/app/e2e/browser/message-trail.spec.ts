import { expect, test } from "../support/fixtures";
import { trackPromptJumpRequests } from "../support/helpers/agent-timeline-gate";
import {
  expectTimelinePromptNotMounted,
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";

test.describe("desktop message trail", () => {
  test("indexes unloaded prompts and jumps with one bounded replacement page", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const jumps = await trackPromptJumpRequests(page, agent.agentId);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openAgentTimeline(page, agent);

      const rail = page.getByTestId("message-trail-rail");
      await expect(rail).toBeVisible();
      await expect(rail.getByRole("tab")).toHaveCount(80);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);

      await rail.getByRole("tab").first().click();
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
      await expectTimelinePromptNotMounted(page, agent.newestPrompt);
      await expect.poll(() => jumps.requests()).toHaveLength(1);
      expect(jumps.requests()[0]).toMatchObject({ limit: 40, replaceWindow: true });

      await page.getByTestId("scroll-to-bottom-button").click();
      await expectTimelinePromptVisible(page, agent.newestPrompt);

      const requestsBeforeLoadedJump = jumps.requests().length;
      await rail.getByRole("tab").last().click();
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      expect(jumps.requests()).toHaveLength(requestsBeforeLoadedJump);

      await rail.getByRole("tab").first().click();
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
      const timelineRequestsBeforeLiveTurn = jumps.timelineRequests().length;
      await agent.client.sendAgentMessage(agent.agentId, "live prompt while viewing old history");
      await agent.client.waitForFinish(agent.agentId, 15_000);
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
      await expectTimelinePromptNotMounted(page, agent.newestPrompt);
      expect(jumps.timelineRequests()).toHaveLength(timelineRequestsBeforeLiveTurn);
    } finally {
      await agent.cleanup();
    }
  });

  test("does not render the rail below the wide-layout breakpoint", async ({ page }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 2 });
    try {
      await page.setViewportSize({ width: 800, height: 900 });
      await openAgentTimeline(page, agent);
      await expect(page.getByTestId("message-trail-rail")).toBeHidden();
    } finally {
      await agent.cleanup();
    }
  });
});
