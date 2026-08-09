import { expect, test } from "./support/fixtures";
import {
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
} from "./support/helpers/timeline-pagination";

test.describe("Agent chat history search", () => {
  test("backfills bounded history, filters, navigates, highlights, and closes", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const agent = await seedLongMockAgentTimeline({ turns: 80 });
    try {
      await openAgentTimeline(page, agent);
      await expectTimelinePromptVisible(page, agent.newestPrompt);

      await page.keyboard.press("Control+f");
      const input = page.getByTestId("chat-history-search-input");
      await expect(input).toBeFocused();
      await input.fill("timeline-pagination-turn");

      await expect(page.getByTestId("chat-history-search-loading")).toHaveCount(0, {
        timeout: 60_000,
      });
      await expect(page.getByTestId("chat-history-search-count")).toHaveText("80 of 80");
      await expect(page.getByTestId("chat-search-result-active")).toHaveCount(1);

      await input.press("Enter");
      await expect(page.getByTestId("chat-history-search-count")).toHaveText("1 of 80");
      await input.press("Shift+Enter");
      await expect(page.getByTestId("chat-history-search-count")).toHaveText("80 of 80");
      await page.getByTestId("chat-history-search-previous").click();
      await expect(page.getByTestId("chat-history-search-count")).toHaveText("79 of 80");

      await page.getByTestId("chat-history-search-filter-user").click();
      await expect(page.getByTestId("chat-history-search-count")).toHaveText("No results");
      await page.getByTestId("chat-history-search-filter-user").click();
      await page.getByTestId("chat-history-search-filter-assistant").click();
      await expect(page.getByTestId("chat-history-search-count")).toHaveText("80 of 80");

      await input.press("Escape");
      await expect(page.getByTestId("chat-history-search")).toHaveCount(0);
      await expect(page.getByTestId("chat-search-result-active")).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
});
