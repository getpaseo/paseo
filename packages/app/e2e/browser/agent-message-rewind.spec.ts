import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { expectAgentIdle, expectAgentReadyToInterrupt } from "../support/helpers/agent-stream";
import {
  cancelAgent,
  fillComposerDraft,
  expectComposerDraft,
  expectComposerVisible,
  submitMessage,
} from "../support/helpers/composer";
import { expectNearBottom, scrollChatAwayFromBottom } from "../support/helpers/agent-bottom-anchor";
import { holdRewindCompletion } from "../support/helpers/agent-timeline-gate";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { userScrollsTimelineToHistoryStart } from "../support/helpers/timeline-pagination";
import {
  closeWorkspaceAgentTab,
  fetchAgentArchivedAt,
  primeAdditionalPage,
  resetSeededPageState,
} from "../support/helpers/archive-tab";

async function completeSubmittedTurn(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
  prompt: string,
): Promise<Locator> {
  await submitMessage(page, prompt);
  const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
  await expect(userMessage).toBeVisible();

  await expectAgentReadyToInterrupt(page);
  const finish = await agent.client.waitForFinish(agent.agentId, 30_000);
  expect(finish.status).toBe("idle");
  await expectAgentIdle(page);
  await expect(page.getByText("(end of synthetic stream)", { exact: true }).last()).toBeVisible();
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
  await expect(page.getByText("(end of synthetic stream)", { exact: true }).last()).toBeVisible();
  await expectAgentIdle(page);
}

async function openAgentOnAnotherClient(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
): Promise<void> {
  await primeAdditionalPage(page);
  await resetSeededPageState(page);
  await openAgentRoute(page, agent);
  await expectComposerVisible(page);
}

/** The prompts the chat shows, in order, each exactly once. */
async function expectPrompts(page: Page, prompts: string[]): Promise<void> {
  const messages = page.getByTestId("user-message");
  await expect(messages).toHaveCount(prompts.length);
  await expect(messages).toContainText(prompts);
}

async function reloadAgentFromTabMenu(page: Page, agentId: string): Promise<void> {
  const tabId = `workspace-tab-agent_${agentId}`;
  await page.getByTestId(tabId).filter({ visible: true }).first().click({ button: "right" });
  await page.getByTestId(`workspace-tab-context-agent_${agentId}-reload-agent`).click();
}

async function archiveAgentByClosingTab(
  page: Page,
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>,
): Promise<void> {
  await closeWorkspaceAgentTab(page, agent.agentId);
  await expect.poll(() => fetchAgentArchivedAt(agent.client, agent.agentId)).not.toBeNull();
}

async function unarchiveAgent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await expect(page.getByText("This agent is archived", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
}

async function expectToast(page: Page, message: string): Promise<void> {
  await expect(page.getByTestId("app-toast-message")).toHaveText(message, { timeout: 30_000 });
}

// The mock provider's resumed session holds no history, so it never matches what Paseo shows.
const UNSYNCED_RELOAD =
  "Reloaded agent, but the provider's history doesn't match this chat, so it wasn't synced";

/** The prompts of the whole conversation, after scrolling up through its older pages. */
async function expectConversationPrompts(page: Page, prompts: string[]): Promise<void> {
  const messages = page.getByTestId("user-message");
  await expect
    .poll(async () => {
      await userScrollsTimelineToHistoryStart(page);
      return await messages.count();
    })
    .toBe(prompts.length);
  await expect(messages).toContainText(prompts);
}

// A row React remounts loses this attribute; one that stays mounted keeps it.
async function markMounted(row: Locator): Promise<void> {
  await row.evaluate((element) => element.setAttribute("data-e2e-mounted", "before-rewind"));
}

async function expectStillMounted(row: Locator): Promise<void> {
  await expect(row).toHaveAttribute("data-e2e-mounted", "before-rewind");
}

test.describe("Agent message rewind", () => {
  test("rewinds a prompt in place on every open client and keeps a human draft", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const retainedPrompt = "Keep this completed turn after rewind.";
    const rewoundPrompt = "Remove this completed turn after rewind.";
    const nextPrompt = "Continue after the rewind.";
    const preservedDraft = "Keep this human draft after rewind.";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "message-rewind-roundtrip-",
      title: "Message rewind roundtrip",
      model: "ten-second-stream",
    });
    const otherClient = await page.context().newPage();

    try {
      const rewindCompletion = await holdRewindCompletion(page, agent.agentId);
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      const retainedMessage = await completeSubmittedTurn(page, agent, retainedPrompt);
      const userMessage = await completeSubmittedTurn(page, agent, rewoundPrompt);

      await test.step("a second client opens the same chat", async () => {
        await openAgentOnAnotherClient(otherClient, agent);
        await expectPrompts(otherClient, [retainedPrompt, rewoundPrompt]);
      });

      await markMounted(retainedMessage);
      await scrollChatAwayFromBottom(page, {
        deltaY: -900,
        minDistanceFromBottom: 300,
      });
      await fillComposerDraft(page, preservedDraft);
      rewindCompletion.clearTimelineStreamCount();

      await test.step("the rewind stays pending until the daemon answers", async () => {
        const rewind = rewindConversation(page, userMessage, rewoundPrompt);
        await rewindCompletion.waitForDelayedResponse();
        await expect(page.getByTestId("rewind-menu-conversation")).toBeDisabled();
        expect(rewindCompletion.timelineStreamCount()).toBe(0);
        rewindCompletion.release();
        await rewind;
      });

      await test.step("the rewound turn leaves without reloading the chat", async () => {
        await expectPrompts(page, [retainedPrompt]);
        await expectStillMounted(retainedMessage);
        expect(rewindCompletion.timelineFetchCount()).toBe(0);
        await expectComposerDraft(page, preservedDraft);
        await expectNearBottom(page);
        await expectPrompts(otherClient, [retainedPrompt]);
      });

      await test.step("the next prompt appears once on both clients", async () => {
        await completeSubmittedTurn(otherClient, agent, nextPrompt);
        await expectPrompts(otherClient, [retainedPrompt, nextPrompt]);
        await expectPrompts(page, [retainedPrompt, nextPrompt]);
      });

      await test.step("a reconnecting client loads the rewound conversation", async () => {
        await otherClient.reload();
        await expectPrompts(otherClient, [retainedPrompt, nextPrompt]);
      });
    } finally {
      await otherClient.close();
      await agent.cleanup();
    }
  });

  test("keeps the rewound conversation through Reload agent, archive and unarchive", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const keptPrompt = "Keep this turn through reload and archive.";
    const rewoundPrompt = "Rewind this turn before reloading.";
    const nextPrompt = "Continue after the rewind, then reload.";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "message-rewind-reload-archive-",
      title: "Message rewind reload archive",
      model: "ten-second-stream",
    });

    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await completeSubmittedTurn(page, agent, keptPrompt);
      const rewound = await completeSubmittedTurn(page, agent, rewoundPrompt);
      await rewindConversation(page, rewound, rewoundPrompt);
      await expectPrompts(page, [keptPrompt]);
      await completeSubmittedTurn(page, agent, nextPrompt);
      await expectPrompts(page, [keptPrompt, nextPrompt]);

      await test.step("Reload agent keeps the chat and says the provider's history was not synced", async () => {
        await reloadAgentFromTabMenu(page, agent.agentId);
        await expectToast(page, UNSYNCED_RELOAD);
        await expectPrompts(page, [keptPrompt, nextPrompt]);
        await expectComposerVisible(page);
      });

      await test.step("the archived chat shows the rewound conversation", async () => {
        await archiveAgentByClosingTab(page, agent);
        await openAgentRoute(page, agent);
        await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        await expectConversationPrompts(page, [keptPrompt, nextPrompt]);
      });

      await test.step("unarchiving keeps the rewound conversation", async () => {
        await unarchiveAgent(page);
        await expectToast(page, UNSYNCED_RELOAD);
        await expectComposerVisible(page);
        await expectConversationPrompts(page, [keptPrompt, nextPrompt]);
      });

      await test.step("a reconnecting client loads the same conversation", async () => {
        await page.reload();
        await expectComposerVisible(page);
        await expectConversationPrompts(page, [keptPrompt, nextPrompt]);
      });
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
