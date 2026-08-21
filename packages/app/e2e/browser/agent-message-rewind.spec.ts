import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { expectAgentIdle, expectAgentReadyToInterrupt } from "../support/helpers/agent-stream";
import {
  cancelAgent,
  expectComposerDraft,
  expectComposerVisible,
  submitMessage,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

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
  await page.getByRole("menuitem", { name: "Rewind conversation", exact: true }).click();
}

async function expectTurnCompletesNormally(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
): Promise<void> {
  const finish = await agent.client.waitForFinish(agent.agentId, 30_000);
  expect(finish.status).toBe("idle");
  await expect(page.getByText("(end of synthetic stream)", { exact: true })).toBeVisible();
  await expectAgentIdle(page);
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

  test("keeps a pre-acknowledgement turn running after rewind is rejected", async ({ page }) => {
    test.setTimeout(90_000);
    const prompt = "Delay synthetic user message by 2000ms.";
    const rewindError = "Cannot rewind before the provider acknowledges the submitted prompt";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "message-rewind-pre-echo-",
      title: "Message rewind pre-echo",
      model: "ten-second-stream",
    });

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await submitMessage(page, prompt);
      const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
      await expect(userMessage).toBeVisible();
      await expectAgentReadyToInterrupt(page);

      await rewindConversation(page, userMessage, prompt);

      await expect(page.getByText(rewindError, { exact: true })).toBeVisible();
      await expectAgentReadyToInterrupt(page);
      await expectTurnCompletesNormally(page, agent);
    } finally {
      await agent.cleanup();
    }
  });

  test("does not offer rewind for daemon-handled prompts", async ({ page }) => {
    const commandPrompt = "/mock handled-command";
    const providerPrompt = "Keep this provider-bound prompt rewindable.";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "message-rewind-daemon-command-",
      title: "Message rewind daemon command",
      model: "ten-second-stream",
    });

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await expectAgentIdle(page);

      await submitMessage(page, commandPrompt);
      const commandMessage = page.getByTestId("user-message").filter({ hasText: commandPrompt });
      await expect(commandMessage).toBeVisible();
      await expect(page.getByText("Mock command handled", { exact: true })).toBeVisible();
      await commandMessage.getByText(commandPrompt, { exact: true }).hover();
      await expect(
        commandMessage.getByRole("button", { name: "Rewind to this message", exact: true }),
      ).toHaveCount(0);

      await submitMessage(page, providerPrompt);
      const providerMessage = page.getByTestId("user-message").filter({ hasText: providerPrompt });
      await expect(providerMessage).toBeVisible();
      await expectAgentReadyToInterrupt(page);
      await providerMessage.getByText(providerPrompt, { exact: true }).hover();
      await expect(
        providerMessage.getByRole("button", { name: "Rewind to this message", exact: true }),
      ).toBeVisible();
      await cancelAgent(page);
      await expectAgentIdle(page);
    } finally {
      await agent.cleanup();
    }
  });
});
