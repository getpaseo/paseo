import { test } from "./fixtures";
import {
  awaitAssistantMessage,
  expectAgentIdle,
  expectInlineWorkingIndicator,
  expectTurnCopyButton,
  expectScrolledToBottom,
} from "./helpers/agent-stream";
import { startRunningMockAgent } from "./helpers/composer";
import { readScrollMetrics, waitForContentGrowth } from "./helpers/agent-bottom-anchor";

test.describe("Agent stream UI", () => {
  test("auto-scroll sticks to bottom across token bursts", async ({ page }) => {
    test.setTimeout(120_000);
    const { client, repo } = await startRunningMockAgent(page, {
      prefix: "stream-scroll-",
      model: "one-minute-stream",
      prompt: "Stream for auto-scroll test.",
    });
    try {
      await awaitAssistantMessage(page);
      await expectScrolledToBottom(page);

      const { contentHeight } = await readScrollMetrics(page);
      await waitForContentGrowth(page, contentHeight);
      await expectScrolledToBottom(page);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("working-indicator transitions to copy-button when stream ends", async ({ page }) => {
    test.setTimeout(60_000);
    const { client, repo } = await startRunningMockAgent(page, {
      prefix: "stream-indicator-",
      model: "ten-second-stream",
      prompt: "Stream briefly for indicator transition test.",
    });
    try {
      await expectInlineWorkingIndicator(page);
      await expectAgentIdle(page, 30_000);
      await expectTurnCopyButton(page);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
