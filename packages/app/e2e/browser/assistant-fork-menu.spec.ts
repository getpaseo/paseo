import {
  captureChatHistory,
  expectRewoundHistoryIsPrivate,
  rewindForkPrompt,
  openChatHistory,
  closeChatHistory,
  followChatHistorySource,
  expectInlineChatHistory,
  expectResentChatHistory,
  expectNoDraftChatHistory,
  removeDraftChatHistory,
  expectSavedAnswerEnding,
  expectChatHistoryMessageStyles,
  sendChatHistoryFromAnotherClient,
  setChatHistoryViewport,
} from "../support/helpers/chat-history";
import { expect, test as base } from "../support/fixtures";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import {
  getActiveForkAgentId,
  expectActiveForkAgent,
  expectChatHistoryAttachment,
  expectInFlightForkAvailable,
  expectLiveAssistantText,
  forkInFlightTurnToNewTab,
  forkMostRecentAssistantTurnToNewTab,
  forkMostRecentAssistantTurnToNewWorkspace,
  observeForkAttachment,
} from "../support/helpers/assistant-fork";
import {
  expectComposerDraft,
  expectComposerVisible,
  submitMessage,
} from "../support/helpers/composer";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentOptions,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { submitNewWorkspaceEmpty } from "../support/helpers/new-workspace";

const test = base.extend<{
  seedForkWorkspace: (options: MockAgentOptions) => Promise<MockAgentWorkspace>;
}>({
  seedForkWorkspace: async ({ browserName: _browserName }, provide) => {
    const sessions: MockAgentWorkspace[] = [];
    await provide(async (options) => {
      const session = await seedMockAgentWorkspace(options);
      sessions.push(session);
      return session;
    });
    await Promise.allSettled(sessions.map((session) => session.cleanup()));
  },
});

test.describe("Assistant fork menu", () => {
  test.describe.configure({ timeout: 180_000 });

  test("reads fork history before and after sending and opens its source after reload", async ({
    page,
    seedForkWorkspace,
  }, testInfo) => {
    const initialPrompt = "Show me a small TypeScript example.";
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-readable-",
      title: "Original conversation",
      initialPrompt,
      featureValues: {
        mockAssistantResponse:
          "## The answer\nHere is a **small example**:\n\n```ts\nconst answer = 42;\n```\n\n[User] in prose is not a new message.",
      },
      model: "ten-second-stream",
    });
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);
    await forkMostRecentAssistantTurnToNewTab(page);
    await expectInlineChatHistory(page, [initialPrompt]);
    await expectChatHistoryMessageStyles(page, initialPrompt);
    await captureChatHistory(page, testInfo, "history-wide.png");
    await submitMessage(page, "emit 1 coalesced agent stream updates for the fork.");
    const forkAgentId = await getActiveForkAgentId(page);
    await session.client.waitForFinish(forkAgentId, 45_000);

    await openAgentRoute(page, { workspaceId: session.workspaceId, agentId: forkAgentId });
    await page.reload();
    await setChatHistoryViewport(page, "compact");
    await expectInlineChatHistory(page, [initialPrompt]);
    await expectChatHistoryMessageStyles(page, initialPrompt);
    await captureChatHistory(page, testInfo, "history-compact.png");
    await followChatHistorySource(page);
    await setChatHistoryViewport(page, "wide");
    await expectActiveForkAgent(page, session.agentId);

    await openAgentRoute(page, { workspaceId: session.workspaceId, agentId: forkAgentId });
    await expectActiveForkAgent(page, forkAgentId);
    await forkMostRecentAssistantTurnToNewTab(page);
    await expectInlineChatHistory(page, [initialPrompt, "updates for the fork."]);
    await followChatHistorySource(page);
    await expectActiveForkAgent(page, forkAgentId);
  });

  test("reads the ending of a long saved answer before sending and after reload", async ({
    page,
    seedForkWorkspace,
  }, testInfo) => {
    const ending = "The complete saved answer ends here.";
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-long-answer-",
      title: "Long original conversation",
      initialPrompt: "Explain the full context.",
      model: "ten-second-stream",
      featureValues: {
        mockAssistantResponse: "Retained context. ".repeat(2400) + "\n\n" + ending,
      },
    });
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);
    await forkMostRecentAssistantTurnToNewTab(page);
    await expectSavedAnswerEnding(page, ending);
    await captureChatHistory(page, testInfo, "long-history-draft.png");
    await submitMessage(page, "emit 1 coalesced agent stream updates for the fork.");
    const forkAgentId = await getActiveForkAgentId(page);
    await session.client.waitForFinish(forkAgentId, 45_000);
    await page.reload();
    await setChatHistoryViewport(page, "compact");
    await expectSavedAnswerEnding(page, ending);
    await captureChatHistory(page, testInfo, "long-history-reloaded.png");
  });

  for (const prompt of ["", "Continue the fork"]) {
    test(`retains inherited context when rewinding the first fork prompt (${prompt || "history only"})`, async ({
      page,
      seedForkWorkspace,
    }, testInfo) => {
      const initialPrompt = "emit 1 coalesced agent stream updates for rewindable fork history.";
      const session = await seedForkWorkspace({
        repoPrefix: "fork-rewind-",
        title: "Rewind source",
        initialPrompt,
        model: "ten-second-stream",
      });
      await openAgentRoute(page, session);
      await expectComposerVisible(page);
      await awaitAssistantMessage(page);
      await session.client.waitForFinish(session.agentId, 45_000);
      await forkMostRecentAssistantTurnToNewTab(page);
      await submitMessage(page, prompt);
      const forkId = await getActiveForkAgentId(page);
      await session.client.waitForFinish(forkId, 45_000);
      await page.reload();
      await expectInlineChatHistory(page, [initialPrompt]);
      await rewindForkPrompt(page);
      await expectRewoundHistoryIsPrivate(page, session.agentId, forkId);
      await openChatHistory(page, "draft", [initialPrompt]);
      await closeChatHistory(page);
      await page.reload();
      await expectRewoundHistoryIsPrivate(page, session.agentId, forkId);
      await expectComposerDraft(page, prompt);
      await openChatHistory(page, "draft", [initialPrompt]);
      await closeChatHistory(page);
      await submitMessage(page, prompt);
      await session.client.waitForFinish(forkId, 45_000);
      await page.reload();
      await expectResentChatHistory(page, [initialPrompt]);
      await expectNoDraftChatHistory(page);
      await captureChatHistory(page, testInfo, "history-after-rewind.png");
      await rewindForkPrompt(page);
      await openChatHistory(page, "draft", [initialPrompt]);
      await closeChatHistory(page);
      await removeDraftChatHistory(page);
      await page.reload();
      await expectComposerVisible(page);
      await expectComposerDraft(page, prompt);
      await expectNoDraftChatHistory(page);
    });
  }

  test("shows history sent from another connected client without reloading", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-live-history-",
      title: "Live history recipient",
      model: "ten-second-stream",
    });
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    const history = "[User] Context inherited on another device.";
    await sendChatHistoryFromAnotherClient(session, history);
    await expectInlineChatHistory(page, [history]);
    await session.client.waitForFinish(session.agentId, 45_000);
  });

  test("forks a failed assistant turn that has no provider message id", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-failed-turn-",
      title: "Assistant fork failed turn",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, "Emit a synthetic turn failure.");
    await expect(page.getByText("[System Error] Requested mock provider failure")).toBeVisible({
      timeout: 30_000,
    });

    await forkMostRecentAssistantTurnToNewTab(page);
    await expectChatHistoryAttachment(page);
  });

  test("forks a streaming assistant turn without interrupting it", async ({
    page,
    seedForkWorkspace,
  }) => {
    const visibleBeforeFork = "where the auto-scroll logic actually lives";
    const visibleAfterFork = "the first useful step is to read the relevant files";
    const sourceAgentTitle = "Assistant fork in flight";
    const forkAttachment = observeForkAttachment(page);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-in-flight-",
      title: sourceAgentTitle,
      model: "thirty-minute-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await submitMessage(page, "Walk me through the scroll anchor behavior.");

    await expectInFlightForkAvailable(page);
    await expectLiveAssistantText(page, visibleBeforeFork);

    await forkInFlightTurnToNewTab(page);
    await expectChatHistoryAttachment(page);
    expect(await forkAttachment.waitForText()).toContain(visibleBeforeFork);
    await expect(page.getByRole("button", { name: "Menu backdrop", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: sourceAgentTitle }).click();
    await expectLiveAssistantText(page, visibleAfterFork);
  });

  test("focuses a forked assistant turn in a new workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-focused-tab-",
      title: "Assistant fork focused tab",
      initialPrompt: "emit 1 coalesced agent stream updates for initial assistant fork turn.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await submitMessage(page, "emit 1 coalesced agent stream updates while this tab is visible.");
    await session.client.waitForFinish(session.agentId, 45_000);
    await awaitAssistantMessage(page);

    const agentTab = page.getByTestId(`workspace-tab-agent_${session.agentId}`);
    await expect(agentTab).toHaveAttribute("aria-selected", "true");

    await forkMostRecentAssistantTurnToNewTab(page);

    const selectedTab = page
      .getByTestId("workspace-tabs-row")
      .getByRole("button")
      .and(page.locator('[aria-selected="true"]'));
    await expect(selectedTab).toHaveAttribute("data-testid", /^workspace-tab-draft_/, {
      timeout: 30_000,
    });
    await expect(agentTab).toHaveAttribute("aria-selected", "false");
    await expectChatHistoryAttachment(page);
  });

  test("keeps the fork attachment after submitting an existing-workspace draft tab", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-tab-submit-",
      title: "Assistant fork tab submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork tab submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewTab(page);
    await expectChatHistoryAttachment(page);

    await submitMessage(page, "");

    await expectInlineChatHistory(page, ["updates for assistant fork tab submit."]);
  });

  test("forks an assistant turn into New Workspace and keeps the attachment across host changes", async ({
    page,
    seedForkWorkspace,
  }) => {
    await seedSavedSettingsHosts(page, [
      {
        serverId: getServerId(),
        label: "localhost",
        endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
      },
      {
        serverId: "secondary-assistant-fork-host",
        label: "Secondary host",
        // The host does not need to be reachable; this pins that the draft-scoped
        // attachment survives changing the selected target host.
        endpoint: "127.0.0.1:9",
      },
    ]);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-workspace-",
      title: "Assistant fork workspace",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork new workspace.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewWorkspace(page);

    await expect(page).toHaveURL(/\/new\?.*draftId=/, { timeout: 30_000 });
    await expectChatHistoryAttachment(page);

    await page.getByTestId("host-picker-trigger").click();
    await page
      .getByTestId("new-workspace-host-picker-option-secondary-assistant-fork-host")
      .click();
    await expectChatHistoryAttachment(page);
  });

  test("keeps the fork attachment after the new agent receives its user message", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-submit-",
      title: "Assistant fork submit",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork submit.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewWorkspace(page);
    await expectChatHistoryAttachment(page);

    await submitNewWorkspaceEmpty(page);

    await expectInlineChatHistory(page, ["updates for assistant fork submit."]);
  });
});
