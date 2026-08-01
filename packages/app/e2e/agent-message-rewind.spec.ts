import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "./fixtures";
import { expectComposerDraft, expectComposerVisible, submitMessage } from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

async function completeSubmittedTurn(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
  prompt: string,
): Promise<Locator> {
  await submitMessage(page, prompt);
  const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
  await expect(userMessage).toBeVisible();

  const finish = await agent.client.waitForFinish(agent.agentId, 30_000);
  expect(finish.status).toBe("idle");
  await expect(page.getByText("(end of synthetic stream)", { exact: true })).toBeVisible();
  await expect(userMessage).toHaveAttribute("aria-busy", "false");
  return userMessage;
}

async function rewindConversation(page: Page, userMessage: Locator, prompt: string): Promise<void> {
  await userMessage.getByText(prompt, { exact: true }).hover();
  await userMessage.getByRole("button", { name: "Rewind to this message", exact: true }).click();
  await page.getByRole("button", { name: "Rewind conversation", exact: true }).click();
}

test.describe("Agent message rewind", () => {
  test("rewinds a submitted prompt and restores it to the composer", async ({ page }) => {
    test.setTimeout(90_000);
    const prompt = "Restore this submitted prompt after rewind.";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "message-rewind-roundtrip-",
      title: "Message rewind roundtrip",
      model: "ten-second-stream",
    });

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      const userMessage = await completeSubmittedTurn(page, agent, prompt);

      await rewindConversation(page, userMessage, prompt);

      await expect(page.getByText("(end of synthetic stream)", { exact: true })).toHaveCount(0);
      await expectComposerDraft(page, prompt);
    } finally {
      await agent.cleanup();
    }
  });
});
