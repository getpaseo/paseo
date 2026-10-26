import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

type ChatDisplay = "full" | "collapseToolCalls" | "collapseTurns";

async function useChatDisplay(page: Page, chatDisplay: ChatDisplay): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ chatDisplay: value }));
  }, chatDisplay);
}

async function seedAnsweredAgent(title: string) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "turn-collapse-",
    title,
    model: "ten-second-stream",
    initialPrompt: "Why does the chat stop following new output?",
  });
  await agent.client.waitForFinish(agent.agentId, 30_000);
  await agent.client.sendAgentMessage(agent.agentId, "Make the fix and run the burst script.");
  await agent.client.waitForFinish(agent.agentId, 30_000);
  return agent;
}

/** Chat rows between the latest turn's summary line and its reply, in document order. */
async function rowsBetweenLatestSummaryAndReply(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-message-id]")];
    const summaryRow = rows.findLastIndex((row) => row.querySelector("[data-testid=turn-summary]"));
    const replyRow = rows.findLastIndex((row) =>
      row.querySelector("[data-testid=assistant-message]"),
    );
    return replyRow - summaryRow - 1;
  });
}

test.describe("Turn collapse", () => {
  test("folds each answered turn behind a summary line that opens it", async ({ page }) => {
    test.setTimeout(120_000);
    await useChatDisplay(page, "collapseTurns");
    const agent = await seedAnsweredAgent("Turn collapse");
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      const summary = page.getByTestId("turn-summary").last().getByRole("button");
      await expect(summary).toHaveText(/^Wrote \d+ messages?, edited 1 file/);
      // Text chunks that stream back to back merge into one message, so the reply holds
      // at least the stream's last chunk.
      await expect(page.getByTestId("assistant-message").last()).toHaveText(
        /\(end of synthetic stream\)$/,
      );
      await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(0);

      await summary.click();
      await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBeGreaterThan(0);
      await expect(summary).toBeInViewport();

      await summary.click();
      await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(0);
    } finally {
      await agent.cleanup();
    }
  });
});
