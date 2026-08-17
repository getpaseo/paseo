import { expect, test } from "../support/fixtures";
import { trackPromptJumpRequests } from "../support/helpers/agent-timeline-gate";
import {
  clickChatOutlineRowEdge,
  disableChatOutlineFromAppearance,
  expectActiveChatOutlinePrompt,
  expectChatOutlinePreview,
  expectChatOutlinePrompts,
  expectChatOutlinePromptToRemainBare,
  expectLiveTurnPromptAboveFoldAndActive,
  expectNoChatOutlinePreviewWhileCrossingToSidebar,
  expectNoChatOutline,
  expectNoChatOutlinePreview,
  expectOneActiveChatOutlinePrompt,
  focusChatOutlinePrompt,
  hoverChatOutlinePrompt,
  chatOutlineRail,
  movePointerOffChatOutline,
  pointAtChatOutlineRowEdge,
  pressEnterOnFocusedPrompt,
  splitCurrentPanelRight,
} from "../support/helpers/chat-outline";
import {
  expectTimelineAtMaximumScrollWithPromptVisible,
  expectTimelinePromptNotMounted,
  expectTimelinePromptLandedBelowTop,
  expectTimelinePromptVisible,
  holdOlderHistoryPages,
  openAgentTimeline,
  scrollThroughOlderHistoryPages,
  scrollTimelineToNewestLoadedEdge,
  scrollTimelineToOldestLoadedEdge,
  seedLongMockAgentTimeline,
  type LongTimelineAgent,
} from "../support/helpers/timeline-pagination";

// Wide enough that the timeline panel clears the rail's MIN_PANEL_WIDTH with room
// to spare. At 1280 the panel measures 960, which sits too close to the threshold
// for chrome-width changes elsewhere to stay out of these tests.
const WIDE_VIEWPORT = { width: 1440, height: 900 };
const LOADED_TURNS = 16;

test.describe("desktop chat outline", () => {
  test("indexes unloaded prompts and jumps with one bounded merged page", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      const jumps = await trackPromptJumpRequests(page, agent.agentId);
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);

      const rail = chatOutlineRail(page);
      await expectChatOutlinePrompts(page, 80);
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);

      await rail.getByRole("tab").nth(39).click();
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[39]);
      await expect.poll(() => jumps.requests()).toHaveLength(1);
      expect(jumps.requests()[0]).toMatchObject({ limit: 40, mergeWindow: true });

      await page.getByTestId("scroll-to-bottom-button").click();
      await expectTimelinePromptVisible(page, agent.newestPrompt);

      const requestsBeforeLoadedJump = jumps.requests().length;
      await rail.getByRole("tab").last().click();
      await expectTimelinePromptVisible(page, agent.newestPrompt);
      expect(jumps.requests()).toHaveLength(requestsBeforeLoadedJump);

      await rail.getByRole("tab").first().click();
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
      await agent.client.sendAgentMessage(agent.agentId, "live prompt while viewing old history");
      await agent.client.waitForFinish(agent.agentId, 15_000);
      await expectTimelinePromptVisible(page, agent.oldestPrompt);
    } finally {
      await agent.cleanup();
    }
  });

  test.describe("with the whole conversation loaded", () => {
    let agent: LongTimelineAgent;
    let promptTimestamps: string[];

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      agent = await seedLongMockAgentTimeline({ turns: LOADED_TURNS });
      const promptIndex = await agent.client.listAgentTimelinePrompts(agent.agentId);
      promptTimestamps = [];
      for (const prompt of promptIndex.prompts) {
        promptTimestamps.push(prompt.timestamp);
      }
    });

    test.afterAll(async () => {
      await agent.cleanup();
    });

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);
      await expectChatOutlinePrompts(page, LOADED_TURNS);
    });

    test("previews the prompt under the pointer, anywhere across its row", async ({ page }) => {
      await hoverChatOutlinePrompt(page, 2);
      await expectChatOutlinePreview(page, agent.prompts[1], promptTimestamps[1]);

      await pointAtChatOutlineRowEdge(page, 7);
      await expectChatOutlinePreview(page, agent.prompts[6], promptTimestamps[6]);

      await movePointerOffChatOutline(page);
      await expectNoChatOutlinePreview(page);
    });

    test("does not preview while crossing the rail toward the sidebar", async ({ page }) => {
      await expectNoChatOutlinePreviewWhileCrossingToSidebar(page);
    });

    test("closes the preview when the pointer leaves after a jump", async ({ page }) => {
      await clickChatOutlineRowEdge(page, 4);
      await movePointerOffChatOutline(page);

      await expectNoChatOutlinePreview(page);
    });

    test("previews and jumps to the focused prompt from the keyboard", async ({ page }) => {
      await focusChatOutlinePrompt(page, 1);
      await expectChatOutlinePreview(page, agent.prompts[0], promptTimestamps[0]);

      await pressEnterOnFocusedPrompt(page);
      await expectTimelinePromptLandedBelowTop(page, agent.oldestPrompt);
      await expectActiveChatOutlinePrompt(page, 1);
    });

    test("moves the active mark as the reader jumps and scrolls", async ({ page }) => {
      await expectOneActiveChatOutlinePrompt(page);

      await clickChatOutlineRowEdge(page, 4);
      await expectTimelinePromptVisible(page, agent.prompts[3]);
      await expectActiveChatOutlinePrompt(page, 4);

      await scrollTimelineToOldestLoadedEdge(page);
      await expectActiveChatOutlinePrompt(page, 1);
    });

    test("keeps a clicked prompt free of persistent selection chrome", async ({ page }) => {
      await clickChatOutlineRowEdge(page, 4);

      await expectChatOutlinePromptToRemainBare(page, 4);
    });

    test("clamps the newest prompt at maximum scroll while keeping it visible", async ({
      page,
    }) => {
      await clickChatOutlineRowEdge(page, LOADED_TURNS);

      await expectTimelineAtMaximumScrollWithPromptVisible(page, agent.newestPrompt);
    });

    test("keeps the current prompt active throughout a long live assistant turn", async ({
      page,
    }) => {
      const prompt = "chat outline live turn reading position";
      await agent.client.sendAgentMessage(agent.agentId, prompt);
      try {
        await expectLiveTurnPromptAboveFoldAndActive(page, prompt, LOADED_TURNS + 1);
      } finally {
        await agent.client.waitForFinish(agent.agentId, 15_000);
      }
    });
  });

  test.describe("with virtualized loaded history", () => {
    let agent: LongTimelineAgent;

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      agent = await seedLongMockAgentTimeline({ turns: 80 });
    });

    test.afterAll(async () => {
      await agent.cleanup();
    });

    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(WIDE_VIEWPORT);
    });

    test("pins a loaded prompt inside the virtualized block without fetching", async ({ page }) => {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectChatOutlinePrompts(page, 80);
      await scrollThroughOlderHistoryPages(page, 2, history);
      await scrollTimelineToNewestLoadedEdge(page);
      const requestsBeforeJump = history.requestCount();

      await clickChatOutlineRowEdge(page, 30);
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[29]);

      expect(history.requestCount()).toBe(requestsBeforeJump);
    });

    test("pins a newer loaded prompt when jumping downward from old history", async ({ page }) => {
      const history = await holdOlderHistoryPages(page, agent);
      await openAgentTimeline(page, agent);
      await expectChatOutlinePrompts(page, 80);
      await scrollThroughOlderHistoryPages(page, 2, history);
      await scrollTimelineToNewestLoadedEdge(page);

      await clickChatOutlineRowEdge(page, 30);
      await expectTimelinePromptLandedBelowTop(page, agent.prompts[29]);

      await clickChatOutlineRowEdge(page, 60);

      await expectTimelinePromptLandedBelowTop(page, agent.prompts[59]);
    });
  });

  test("hides the rail when a split makes its panel narrow", async ({ page }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 2 });
    try {
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);

      await splitCurrentPanelRight(page);

      await expectNoChatOutline(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("can be disabled from Appearance settings", async ({ page }) => {
    const agent = await seedLongMockAgentTimeline({ turns: 2 });
    try {
      await page.setViewportSize(WIDE_VIEWPORT);
      await openAgentTimeline(page, agent);

      await disableChatOutlineFromAppearance(page);

      await expectNoChatOutline(page);
    } finally {
      await agent.cleanup();
    }
  });
});
