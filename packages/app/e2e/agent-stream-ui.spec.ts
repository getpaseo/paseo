import { test } from "./fixtures";
import {
  awaitAssistantMessage,
  expectAgentIdle,
  expectInlineWorkingIndicator,
  expectTurnCopyButton,
  expectScrollFollowsNewContent,
} from "./helpers/agent-stream";
import { clickNewChat } from "./helpers/launcher";
import { startRunningMockAgent } from "./helpers/composer";

test.describe("Agent stream UI", () => {
  test("auto-scroll sticks to bottom across token bursts", async ({ page }) => {
    test.setTimeout(120_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "stream-scroll-",
      model: "one-minute-stream",
      prompt: "Stream for auto-scroll test.",
    });
    try {
      await awaitAssistantMessage(page);
      await expectScrollFollowsNewContent(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("working-indicator transitions to copy-button when stream ends", async ({ page }) => {
    test.setTimeout(60_000);
    const agent = await startRunningMockAgent(page, {
      prefix: "stream-indicator-",
      model: "ten-second-stream",
      prompt: "Stream briefly for indicator transition test.",
    });
    try {
      await awaitAssistantMessage(page);
      await expectInlineWorkingIndicator(page);
      await expectAgentIdle(page, 30_000);
      await expectTurnCopyButton(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("shows elapsed timer on first app-created running turn", async ({ page, withWorkspace }) => {
    test.setTimeout(90_000);
    const workspace = await withWorkspace({ prefix: "stream-first-app-turn-timer-" });
    await workspace.navigateTo();
    await clickNewChat(page);
    await page.getByText("Model defaults are still loading").waitFor({
      state: "hidden",
      timeout: 30_000,
    });
    const prompt = "Stream briefly for first app-created turn timer test.";
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await page.getByText(prompt, { exact: true }).first().waitFor({ state: "visible" });
    await awaitAssistantMessage(page);
    await expectInlineWorkingIndicator(page);
    await page.getByTestId("turn-working-elapsed").waitFor({ state: "visible", timeout: 5_000 });
  });
});
