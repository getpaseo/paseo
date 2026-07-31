import { expect, test } from "./fixtures";
import {
  expectQueuedMessageButton,
  fillComposerDraft,
  sendDraftToQueue,
  startRunningMockAgent,
} from "./helpers/composer";
import { installDaemonWebSocketGate } from "./helpers/daemon-websocket-gate";

test.describe("Agent message submission", () => {
  test("automatically sends the next queued message after an authoritative turn completion", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const gate = await installDaemonWebSocketGate(page);
    const agent = await startRunningMockAgent(page, {
      prefix: "queued-auto-drain-",
      model: "ten-second-stream",
      prompt: "Run the first turn before the queued follow-up.",
    });
    const queuedPrompt = "Automatically send this queued follow-up.";

    try {
      gate.holdNextStoppedAgentUpdate(agent.agentId);
      await fillComposerDraft(page, queuedPrompt);
      await sendDraftToQueue(page);
      await expectQueuedMessageButton(page);

      await gate.waitForHeldStoppedAgentUpdate();
      await expect(page.getByRole("button", { name: /stop|cancel/i })).toHaveCount(0, {
        timeout: 15_000,
      });
      await expectQueuedMessageButton(page);
      const queuedUserMessage = page.getByTestId("user-message").filter({ hasText: queuedPrompt });
      await expect(queuedUserMessage).toHaveCount(0);

      gate.releaseHeldStoppedAgentUpdate();

      await expect(queuedUserMessage).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Send queued message now" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("user-message")).toHaveCount(2, { timeout: 15_000 });
    } finally {
      gate.releaseHeldStoppedAgentUpdate();
      await agent.cleanup();
    }
  });
});
