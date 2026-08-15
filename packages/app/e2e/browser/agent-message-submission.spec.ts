import type { Locator, Page } from "@playwright/test";
import { expect, test as baseTest } from "../support/fixtures";
import {
  awaitToolCall,
  expectAgentIdle,
  expectAgentReadyToInterrupt,
  expectAgentSurfacesIdle,
  expectRunningAgentChrome,
  expectVisibleAgentSurfacesIdle,
} from "../support/helpers/agent-stream";
import { gateNextAgentMessage } from "../support/helpers/agent-message-gate";
import {
  attachImageFromMenu,
  expectComposerDraft,
  expectComposerEditable,
  expectAttachmentPill,
  expectComposerVisible,
  cancelAgent,
  composerLocator,
  fillComposerDraft,
  sendDraftToQueue,
  startRunningMockAgent,
  submitMessage,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { delayBrowserAgentCreatedStatus } from "../support/helpers/new-workspace";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { selectModel } from "../support/helpers/app";
import { observeTimelineSubscriptions } from "../support/helpers/timeline-delivery";
import {
  expectResumeOverflowFallsBackToOneTail,
  rememberTimelineRequestCounts,
} from "../support/helpers/timeline-resume";
import { workspaceDeckEntryLocator } from "../support/helpers/workspace-ui";
import {
  scrollTimelineToNewestLoadedEdge,
  scrollTimelineUntilOlderHistoryIsReachable,
} from "../support/helpers/timeline-pagination";
import {
  appendSettledTimelineTurns,
  createSettledMockAgent,
  createSmallAssistantPng,
  emitSettledAssistantImage,
  expectAssistantImageRendered,
} from "../support/helpers/assistant-images";

const IMAGE = {
  name: "message-submission.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
};

interface SubmissionScenario {
  existingPrompt: string;
}

interface DraftCreateScenario {
  workspaceId: string;
  agentCreatedDelay: Awaited<ReturnType<typeof delayBrowserAgentCreatedStatus>>;
}

interface RejectionScenario {
  errorMessage: string;
}

interface UnrelatedRunningScenario {
  gate: Awaited<ReturnType<typeof gateNextAgentMessage>>;
  agent: Awaited<ReturnType<typeof seedMockAgentWorkspace>>;
}

const test = baseTest.extend<{
  submissionScenario: SubmissionScenario;
  draftCreateScenario: DraftCreateScenario;
  rejectionScenario: RejectionScenario;
  unrelatedRunningScenario: UnrelatedRunningScenario;
}>({
  submissionScenario: async ({ page }, provide, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 960 });
    const workspace = await seedWorkspace({
      repoPrefix: `message-submission-layout-${testInfo.workerIndex}-`,
    });
    try {
      const agent = await createSettledMockAgent(workspace, "Message submission layout regression");
      await appendSettledTimelineTurns(workspace.client, agent, 80);
      const image = await createSmallAssistantPng(workspace, {
        alt: "Existing timeline image",
        fileName: "existing-timeline.png",
      });
      await emitSettledAssistantImage(workspace.client, agent, image);
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.id });
      await expectComposerVisible(page);
      await expectAgentIdle(page);
      const oldestPrompt = "image-history-turn-0: emit 1 coalesced agent stream updates";
      await scrollTimelineUntilOlderHistoryIsReachable(page, oldestPrompt);
      await scrollTimelineToNewestLoadedEdge(page);
      await expectAssistantImageRendered(page, image);
      await provide({
        existingPrompt:
          "Emit settled assistant image Markdown: ![Existing timeline image](existing-timeline.png)",
      });
    } finally {
      await workspace.cleanup();
    }
  },
  draftCreateScenario: async ({ page }, provide, testInfo) => {
    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);
    const workspace = await seedWorkspace({
      repoPrefix: `message-create-handoff-${testInfo.workerIndex}-`,
    });
    await provide({ workspaceId: workspace.workspaceId, agentCreatedDelay });
    agentCreatedDelay.release();
    await workspace.cleanup();
  },
  rejectionScenario: async ({ page }, provide, testInfo) => {
    const errorMessage = "Requested mock prompt rejection";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: `message-rejection-${testInfo.workerIndex}-`,
      title: "Message rejection regression",
      model: "ten-second-stream",
      featureValues: { mockPromptRejections: 1 },
    });
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    await provide({ errorMessage });
    await agent.cleanup();
  },
  unrelatedRunningScenario: async ({ page }, provide, testInfo) => {
    const gate = await gateNextAgentMessage(page);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: `unrelated-running-${testInfo.workerIndex}-`,
      title: "Unrelated running transition",
      model: "one-minute-stream",
    });
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    await provide({ gate, agent });
    await agent.cleanup();
  },
});

async function submitMessageWithImage(page: Page, prompt: string): Promise<Locator> {
  await attachImageFromMenu(page, IMAGE);
  await expectAttachmentPill(page, "composer-image-attachment-pill");
  const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
  await composer.fill(prompt);
  await composer.press("Enter");
  const nextFrame = await composer.evaluate(
    (composerElement, submittedPrompt) =>
      new Promise<{
        rowPresent: boolean;
        workingPresent: boolean;
        composerValue: string | null;
        attachmentPresent: boolean;
      }>((resolve) => {
        requestAnimationFrame(() => {
          const rows = Array.from(document.querySelectorAll('[data-testid="user-message"]'));
          const composerInput = composerElement as HTMLInputElement | HTMLTextAreaElement;
          resolve({
            rowPresent: rows.some((row) => row.textContent?.includes(submittedPrompt)),
            workingPresent: Boolean(
              document.querySelector('[data-testid="turn-working-indicator"]'),
            ),
            composerValue: composerInput.value,
            attachmentPresent: Boolean(
              document.querySelector('[data-testid="composer-image-attachment-pill"]'),
            ),
          });
        });
      }),
    prompt,
  );
  expect(nextFrame).toEqual({
    rowPresent: true,
    workingPresent: true,
    composerValue: "",
    attachmentPresent: false,
  });
  return page.getByTestId("user-message").filter({ hasText: prompt }).last();
}

async function submitImageOnlyMessage(page: Page): Promise<Locator> {
  await attachImageFromMenu(page, IMAGE);
  await expectAttachmentPill(page, "composer-image-attachment-pill");
  await page.getByRole("textbox", { name: "Message agent..." }).first().press("Enter");
  const userMessage = page.getByTestId("user-message").last();
  await expect(userMessage).toBeVisible();
  await expect(userMessage.getByRole("button", { name: "Open image attachment" })).toBeVisible();
  return userMessage;
}

async function expectPendingSubmission(page: Page, userMessage: Locator): Promise<void> {
  await expect(userMessage).toBeVisible();
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toHaveValue("");
  await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
  await expect(userMessage.getByTestId("user-message-timestamp")).toBeAttached();
  await expect(userMessage.getByTestId("user-message-trailing-row")).toHaveCSS("opacity", "0");
  await expect(userMessage).toHaveAttribute("aria-busy", "true");
  await expect(userMessage.getByRole("button", { name: "Open image attachment" })).toBeVisible();
}

async function beginTimelineRowStabilityCheck(
  page: Page,
  timelineRow: Locator,
): Promise<() => Promise<void>> {
  await expect(timelineRow).toBeVisible();
  await timelineRow.evaluate((initialRow) => {
    const state = {
      active: true,
      lastTop: initialRow.getBoundingClientRect().top,
      largestDownwardShift: 0,
      sawMissing: false,
    };
    const windowState = window as unknown as Record<string, unknown>;
    windowState.__messageSubmissionTimelineRowStability = state;
    const checkFrame = () => {
      if (!state.active) return;
      if (!initialRow.isConnected) {
        state.sawMissing = true;
        requestAnimationFrame(checkFrame);
        return;
      }
      const top = initialRow.getBoundingClientRect().top;
      state.largestDownwardShift = Math.max(state.largestDownwardShift, top - state.lastTop);
      state.lastTop = top;
      requestAnimationFrame(checkFrame);
    };
    requestAnimationFrame(checkFrame);
  });

  return async () => {
    const result = await page.evaluate(() => {
      const windowState = window as unknown as Record<string, unknown>;
      const state = windowState.__messageSubmissionTimelineRowStability as
        | { active: boolean; largestDownwardShift: number; sawMissing: boolean }
        | undefined;
      if (!state) throw new Error("Timeline-row stability check was not started");
      state.active = false;
      delete windowState.__messageSubmissionTimelineRowStability;
      return { largestDownwardShift: state.largestDownwardShift, sawMissing: state.sawMissing };
    });
    expect(result.sawMissing).toBe(false);
    expect(result.largestDownwardShift).toBeLessThanOrEqual(2);
  };
}

async function submitMessageThatWillBeRejected(page: Page, prompt: string): Promise<void> {
  await attachImageFromMenu(page, IMAGE);
  await expectAttachmentPill(page, "composer-image-attachment-pill");
  const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
  await composer.fill(prompt);
  await composer.press("Enter");
}

async function expectRejectedSubmissionRestored(
  page: Page,
  input: { prompt: string; errorMessage: string },
): Promise<void> {
  await expect(page.getByText(input.errorMessage)).toBeVisible({ timeout: 30_000 });
  await expectComposerDraft(page, input.prompt);
  await expectComposerEditable(page);
  await expectAttachmentPill(page, "composer-image-attachment-pill");
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await expect(page.getByTestId("user-message").filter({ hasText: input.prompt })).toHaveCount(0);
  await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
}

async function retryRestoredSubmission(page: Page, prompt: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message agent..." }).first().press("Enter");
  const userMessage = page.getByTestId("user-message").filter({ hasText: prompt });
  await expect(userMessage).toHaveCount(1);
  await expect(userMessage).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
  await expect(userMessage.getByRole("button", { name: "Open image attachment" })).toBeVisible();
  await expect(page.getByTestId("composer-image-attachment-pill")).toHaveCount(0);
}

async function queueMessage(page: Page, prompt: string): Promise<void> {
  await fillComposerDraft(page, prompt);
  await sendDraftToQueue(page);
}

async function expectQueuedSendFailuresRestored(page: Page, prompts: string[]): Promise<void> {
  await expect(page.getByRole("button", { name: "Send queued message now" })).toHaveCount(
    prompts.length,
  );
  for (const prompt of prompts) {
    await expect(page.getByTestId("user-message").filter({ hasText: prompt })).toHaveCount(0);
  }
}

async function expectFailedSubmissionRestored(page: Page, prompt: string): Promise<void> {
  await expectComposerDraft(page, prompt);
  await expectComposerEditable(page);
  await expect(page.getByTestId("user-message").filter({ hasText: prompt })).toHaveCount(0);
}

async function expectInterruptedTurnOrderAfterReconnect(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `submission-reconnect-${testInfo.workerIndex}-`,
    title: "Submission reconnect ordering",
    model: "ten-second-stream",
  });
  const prompt = "Keep this prompt before its response.";
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await agent.client.sendAgentMessage(agent.agentId, "Start the turn that will be interrupted.");
    await expect(page.getByRole("button", { name: /stop|cancel/i }).first()).toBeVisible();
    await expect(page.getByText("Cycle 1", { exact: true })).toBeVisible();
    await queueMessage(page, prompt);
    gate.setAgentStreamSuppressed(true);
    await page.getByRole("button", { name: "Send queued message now" }).click();
    const promptRow = page.getByTestId("user-message").filter({ hasText: prompt });
    await expect(promptRow).toBeVisible();
    await gate.waitForServerMessage("send_agent_message_response");
    await gate.drop();
    await agent.client.waitForFinish(agent.agentId, 30_000);
    gate.setAgentStreamSuppressed(false);
    gate.forceNextTimelineEpochReset();
    gate.restoreFresh();
    await gate.waitForServerMessage("fetch_agent_timeline_response", 2);
    const response = page.getByText("(end of synthetic stream)", { exact: true }).last();
    await expect(promptRow).toBeVisible();
    await expect(response).toBeVisible();
    await expectRenderedBefore(promptRow, response);
  } finally {
    gate.restore();
    await agent.cleanup();
  }
}

async function expectHiddenStreamingSubmissionOrderAfterWorkspaceEviction(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const subscriptions = observeTimelineSubscriptions(page);
  const gate = await installDaemonWebSocketGate(page);
  const target = await seedMockAgentWorkspace({
    repoPrefix: `submission-hidden-stream-${testInfo.workerIndex}-`,
    title: "Hidden streaming submission",
    model: "ten-second-stream",
  });
  const evictionAgents = await Promise.all(
    Array.from({ length: 3 }, (_unused, index) =>
      seedMockAgentWorkspace({
        repoPrefix: `submission-workspace-eviction-${testInfo.workerIndex}-${index}-`,
        title: `Workspace eviction ${index + 1}`,
      }),
    ),
  );
  const prompt = "Keep this hidden image prompt before its streaming output.";
  const targetDeckEntry = workspaceDeckEntryLocator(page, getServerId(), target.workspaceId);

  try {
    await openAgentRoute(page, target);
    await expectComposerVisible(page);
    await subscriptions.waitForSubscribedAgents([target.agentId]);

    const userMessageCount = gate.getAgentStreamItemCount("user_message");
    gate.setAgentStreamSuppressed(true);
    const promptRow = await submitMessageWithImage(page, prompt);
    await gate.waitForAgentStreamItem("user_message", userMessageCount + 1);

    for (const evictionAgent of evictionAgents) {
      await openAgentRoute(page, evictionAgent);
      await expectComposerVisible(page);
    }
    await expect(targetDeckEntry).toHaveCount(0);
    await subscriptions.waitForSubscribedAgents([evictionAgents[2]!.agentId]);
    gate.setAgentStreamSuppressed(false);

    await target.client.waitForFinish(target.agentId, 30_000);
    const requestsBeforeReturn = rememberTimelineRequestCounts(gate);
    await openAgentRoute(page, target);
    await expectComposerVisible(page);
    await subscriptions.waitForSubscribedAgents([target.agentId]);

    const response = page.getByText("(end of synthetic stream)", { exact: true }).last();
    await expect(promptRow).toBeVisible();
    await expect(response).toBeVisible();
    await expectRenderedBefore(promptRow, response);
    expectResumeOverflowFallsBackToOneTail(gate, requestsBeforeReturn);
  } finally {
    gate.setAgentStreamSuppressed(false);
    gate.restore();
    await Promise.all([...evictionAgents.map((agent) => agent.cleanup()), target.cleanup()]);
  }
}

async function expectCompletedSubmissionClearsAfterMissedRunningTransition(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `submission-missed-running-${testInfo.workerIndex}-`,
    title: "Submission missed running transition",
    model: "ten-second-stream",
  });
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    gate.holdNextClientRequest("send_agent_message_request");
    const userMessage = await submitImageOnlyMessage(page);
    await gate.waitForHeldClientRequest();
    gate.setServerMessageSuppressed("agent_status", true);
    gate.setServerMessageSuppressed("agent_update", true);
    gate.releaseHeldClientRequest();
    await gate.waitForServerMessage("send_agent_message_response");
    await expect(userMessage).toHaveAttribute("aria-busy", "false");
    await gate.drop();
    await agent.client.waitForFinish(agent.agentId, 30_000);
    gate.setServerMessageSuppressed("agent_status", false);
    gate.setServerMessageSuppressed("agent_update", false);
    gate.restoreFresh();
    await gate.waitForServerMessage("fetch_agent_timeline_response", 2);
    await expect(page.getByText("(end of synthetic stream)", { exact: true }).last()).toBeVisible();
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
    await expect(userMessage).toHaveAttribute("aria-busy", "false");
  } finally {
    gate.restore();
    await agent.cleanup();
  }
}

async function expectProviderAcknowledgementBeforeRpcAcceptanceSettlesSubmission(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `submission-ack-before-rpc-${testInfo.workerIndex}-`,
    title: "Submission acknowledgement before RPC",
    model: "ten-second-stream",
  });
  const prompt = "Settle this provider-acknowledged submission.";
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    gate.setServerMessageSuppressed("agent_status", true);
    gate.setServerMessageSuppressed("agent_update", true);
    gate.holdNextServerMessage("send_agent_message_response");
    const userMessage = await submitMessageWithImage(page, prompt);
    await gate.waitForHeldServerMessage();
    await gate.waitForAgentStreamItem("user_message");
    gate.releaseHeldServerMessage();
    await gate.drop();
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
    await expect(userMessage).toHaveAttribute("aria-busy", "false");
  } finally {
    gate.restore();
    await agent.cleanup();
  }
}

async function expectLegacyAssistantStartsAfterInterruptedPrompt(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `submission-legacy-assistant-${testInfo.workerIndex}-`,
    title: "Legacy assistant interrupt boundary",
    model: "ten-second-stream",
  });
  const prompt = "Start the replacement answer after this prompt.";
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await agent.client.sendAgentMessage(agent.agentId, "Start the interrupted answer.");
    await expect(page.getByText("Cycle 1", { exact: true })).toBeVisible();
    await queueMessage(page, prompt);
    gate.setAssistantMessageIdsStripped(true);
    gate.setAgentStreamEventSuppressed("turn_canceled", true);
    await page.getByRole("button", { name: "Send queued message now" }).click();
    const promptRow = page.getByTestId("user-message").filter({ hasText: prompt });
    const replacementAnswer = page.getByText("(end of synthetic stream)", { exact: true }).last();
    await expect(promptRow).toBeVisible();
    await expect(replacementAnswer).toBeVisible({ timeout: 30_000 });
    await expectRenderedBefore(promptRow, replacementAnswer);
  } finally {
    gate.setAssistantMessageIdsStripped(false);
    gate.setAgentStreamEventSuppressed("turn_canceled", false);
    await agent.cleanup();
  }
}

async function expectStaleCanonicalPagePreservesNewerLiveOutput(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `submission-stale-canonical-${testInfo.workerIndex}-`,
    title: "Stale canonical page race",
    model: "one-minute-stream",
  });
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await agent.client.sendAgentMessage(agent.agentId, "End the snapshot at a tool call.");
    await awaitToolCall(page, "read");
    await page
      .getByRole("button", { name: /stop|cancel/i })
      .first()
      .click();
    await expectAgentIdle(page);

    gate.holdNextServerMessage("fetch_agent_timeline_response");
    gate.requestTimelineTail(agent.agentId);
    await gate.waitForHeldServerMessage();
    gate.truncateHeldTimelineAfterLast("tool_call");
    expect(gate.getHeldTimelineLastItemType()).toBe("tool_call");

    const nextPrompt = "Stream after the stale snapshot.";
    await agent.client.sendAgentMessage(agent.agentId, nextPrompt);
    const nextPromptRow = page.getByTestId("user-message").filter({ hasText: nextPrompt });
    const liveAssistant = nextPromptRow.locator(
      'xpath=following::*[@data-testid="assistant-message"][1]',
    );
    await expect(nextPromptRow).toBeVisible();
    await expect(liveAssistant).toContainText("Cycle 1");
    gate.releaseHeldServerMessage();
    await expect(liveAssistant).toContainText("Cycle 1");
  } finally {
    await agent.cleanup();
  }
}

async function expectCanonicalOrderWinsAcrossOverlappingClients(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `submission-cross-client-order-${testInfo.workerIndex}-`,
    title: "Cross-client submission order",
    model: "ten-second-stream",
  });
  const localPrompt = "Send this after the other client turn.";
  const remotePrompt = "Commit this other client turn first.";
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    gate.holdNextClientRequest("send_agent_message_request");
    const localRow = await submitMessageWithImage(page, localPrompt);
    await gate.waitForHeldClientRequest();

    await agent.client.sendAgentMessage(agent.agentId, remotePrompt);
    await agent.client.waitForFinish(agent.agentId, 30_000);
    const remoteRow = page.getByTestId("user-message").filter({ hasText: remotePrompt });
    await expect(remoteRow).toBeVisible();

    const userMessageCount = gate.getAgentStreamItemCount("user_message");
    gate.releaseHeldClientRequest();
    await gate.waitForAgentStreamItem("user_message", userMessageCount + 1);
    await expect(localRow).toHaveAttribute("aria-busy", "false");
    await expect(localRow.getByRole("button", { name: "Open image attachment" })).toBeVisible();
    await expect
      .poll(async () => {
        const localElement = await localRow.elementHandle();
        if (!localElement) return false;
        return remoteRow.evaluate(
          (remoteElement, localNode) =>
            Boolean(
              remoteElement.compareDocumentPosition(localNode) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          localElement,
        );
      })
      .toBe(true);
  } finally {
    gate.restore();
    await agent.cleanup();
  }
}

async function expectDaemonHandledSubmissionSurvivesReload(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `daemon-handled-submission-${testInfo.workerIndex}-`,
    title: "Daemon-handled submission",
  });
  const prompt = "/mock handled-command";
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    await submitMessage(page, prompt);
    const command = page.getByTestId("user-message").filter({ hasText: prompt });
    await expect(command).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText("Mock command handled", { exact: true })).toBeVisible();
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);

    await page.reload();
    await expectComposerVisible(page);
    await expect(command).toBeVisible();
    await expect(command).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText("Mock command handled", { exact: true })).toBeVisible();
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
  } finally {
    await agent.cleanup();
  }
}

async function expectOldHostSubmissionBehavior(
  page: Page,
  testInfo: { workerIndex: number },
): Promise<void> {
  const gate = await installDaemonWebSocketGate(page);
  gate.setCanonicalSubmittedPromptsStripped(true);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: `old-host-submission-${testInfo.workerIndex}-`,
    title: "Old host submission",
  });
  const prompt = "/mock handled-command";
  try {
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    gate.holdNextClientRequest("send_agent_message_request");
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await composer.press("Enter");
    const nextFrame = await composer.evaluate(
      (_, submittedPrompt) =>
        new Promise<{ rowPresent: boolean; ariaBusy: string | null; workingPresent: boolean }>(
          (resolve) => {
            requestAnimationFrame(() => {
              const row = Array.from(
                document.querySelectorAll('[data-testid="user-message"]'),
              ).find((candidate) => candidate.textContent?.includes(submittedPrompt));
              resolve({
                rowPresent: Boolean(row),
                ariaBusy: row?.getAttribute("aria-busy") ?? null,
                workingPresent: Boolean(
                  document.querySelector('[data-testid="turn-working-indicator"]'),
                ),
              });
            });
          },
        ),
      prompt,
    );
    expect(nextFrame).toEqual({ rowPresent: true, ariaBusy: "false", workingPresent: false });

    await gate.waitForHeldClientRequest();
    gate.releaseHeldClientRequest();
    const command = page.getByTestId("user-message").filter({ hasText: prompt });
    await expect(command).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText("Mock command handled", { exact: true })).toBeVisible();
    await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
  } finally {
    gate.restore();
    await agent.cleanup();
  }
}

async function expectRenderedBefore(first: Locator, second: Locator): Promise<void> {
  const secondElement = await second.elementHandle();
  if (!secondElement) throw new Error("Expected the second timeline item to be rendered");
  expect(
    await first.evaluate(
      (firstElement, secondNode) =>
        Boolean(
          firstElement.compareDocumentPosition(secondNode) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      secondElement,
    ),
  ).toBe(true);
}

async function openWorkspaceDraft(page: Page, workspaceId: string): Promise<void> {
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspaceId));
  await waitForWorkspaceTabsVisible(page);
  await page.getByTestId("workspace-new-agent-tab-inline").click();
  await expectComposerVisible(page);
}

async function expectCreatedAgentHandoff(
  page: Page,
  prompt: string,
  userMessage: Locator,
): Promise<void> {
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await expect(page.getByTestId(/^workspace-tab-agent_/).first()).toBeVisible({ timeout: 30_000 });
  await expect(userMessage).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await expect(page.getByTestId("user-message").filter({ hasText: prompt })).toHaveCount(1);
  await expect(userMessage.getByRole("button", { name: "Open image attachment" })).toBeVisible();
}

interface DraftCreatePendingSubmission {
  prompt: string;
  userMessage: Locator;
}

async function beginDraftCreateSubmission(
  page: Page,
  scenario: DraftCreateScenario,
): Promise<DraftCreatePendingSubmission> {
  await openWorkspaceDraft(page, scenario.workspaceId);
  await selectModel(page, "one-minute-stream");
  const prompt = "Keep this row through create handoff.";
  const userMessage = await submitMessageWithImage(page, prompt);
  await scenario.agentCreatedDelay.waitForCreateRequest();
  await scenario.agentCreatedDelay.waitForDelayedCreatedStatus();
  await expectPendingSubmission(page, userMessage);
  return { prompt, userMessage };
}

async function completeDraftCreateSubmission(
  page: Page,
  scenario: DraftCreateScenario,
  pending: DraftCreatePendingSubmission,
): Promise<void> {
  scenario.agentCreatedDelay.release();
  await expectCreatedAgentHandoff(page, pending.prompt, pending.userMessage);
}

test.describe("Agent message submission", () => {
  test("settles an immediately interrupted first prompt", async ({ page }, testInfo) => {
    const workspace = await seedWorkspace({
      repoPrefix: `submission-immediate-interrupt-${testInfo.workerIndex}-`,
    });
    const prompt = "Withhold synthetic user message until interrupted.";
    try {
      await openWorkspaceDraft(page, workspace.workspaceId);
      await selectModel(page, "one-minute-stream");

      await submitMessage(page, prompt);
      await expectAgentReadyToInterrupt(page);
      await page.getByRole("button", { name: "Stop agent", exact: true }).click();

      const submittedPrompt = page.getByTestId("user-message").filter({ hasText: prompt });
      await expect(submittedPrompt).toHaveCount(1);
      await expect(submittedPrompt).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      await expect(page.getByText("(end of synthetic stream)", { exact: true })).toHaveCount(0);
      await expectVisibleAgentSurfacesIdle(page);
      await expectComposerEditable(page);

      await page.reload();
      await expect(submittedPrompt).toHaveCount(1);
      await expect(submittedPrompt).toHaveAttribute("aria-busy", "false");
      await expectVisibleAgentSurfacesIdle(page);
      await expectComposerEditable(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps one canonical prompt when the provider echoes before accepting", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({
      repoPrefix: `submission-echo-before-accept-${testInfo.workerIndex}-`,
    });
    const prompt = "Emit synthetic user message before accepting turn.";
    try {
      await openWorkspaceDraft(page, workspace.workspaceId);
      await selectModel(page, "one-minute-stream");

      await submitMessage(page, prompt);
      await expectAgentReadyToInterrupt(page);
      await page.getByRole("button", { name: "Stop agent", exact: true }).click();
      await expectVisibleAgentSurfacesIdle(page);

      await page.reload();
      const submittedPrompt = page.getByTestId("user-message").filter({ hasText: prompt });
      await expect(submittedPrompt).toHaveCount(1);
      await expect(submittedPrompt).toHaveAttribute("aria-busy", "false");
      await expectVisibleAgentSurfacesIdle(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("enriches a visible prompt when the provider identity arrives later", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({
      repoPrefix: `submission-late-provider-identity-${testInfo.workerIndex}-`,
    });
    const prompt = "Delay synthetic user message by 2000ms.";
    try {
      await openWorkspaceDraft(page, workspace.workspaceId);
      await selectModel(page, "one-minute-stream");

      await submitMessage(page, prompt);
      const submittedPrompt = page.getByTestId("user-message").filter({ hasText: prompt });
      await expect(submittedPrompt).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      const marker = `late-provider-identity-${Date.now()}`;
      await submittedPrompt.evaluate((element, value) => {
        element.dataset.lateProviderIdentity = value;
      }, marker);

      await submittedPrompt.hover();
      await expect(submittedPrompt.getByTestId("rewind-menu-trigger")).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.locator(`[data-late-provider-identity="${marker}"]`)).toBeVisible();
      await page.getByRole("button", { name: "Stop agent", exact: true }).click();
      await expectVisibleAgentSurfacesIdle(page);
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps one prompt when its provider echo crosses the bounded tail", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({
      repoPrefix: `submission-echo-past-tail-${testInfo.workerIndex}-`,
    });
    const prompt = "Emit 205 assistant messages before synthetic user message.";
    try {
      await openWorkspaceDraft(page, workspace.workspaceId);
      await selectModel(page, "one-minute-stream");

      await submitMessage(page, prompt);
      const submittedPrompt = page.getByTestId("user-message").filter({ hasText: prompt });
      await expect(submittedPrompt).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      await expectVisibleAgentSurfacesIdle(page);
      await page.reload();

      await expect(submittedPrompt).toHaveCount(0);
      await scrollTimelineUntilOlderHistoryIsReachable(page, prompt);
      await expect(submittedPrompt).toHaveCount(1);
      await expect(submittedPrompt).toHaveAttribute("aria-busy", "false");
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps one Stop action while submitting into a running agent", async ({ page }) => {
    const gate = await installDaemonWebSocketGate(page);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "submission-running-action-",
      title: "Running submission action",
      model: "one-minute-stream",
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await submitMessage(page, "Keep running while the next prompt is submitted.");
      await expectAgentReadyToInterrupt(page);

      gate.holdNextClientRequest("send_agent_message_request");
      await fillComposerDraft(page, "Replace the running turn without duplicating its action.");
      await expect(
        page.getByRole("button", { name: "Send and interrupt", exact: true }),
      ).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Interrupt agent", exact: true })).toHaveCount(
        0,
      );
      await composerLocator(page).press("Enter");
      await gate.waitForHeldClientRequest();

      await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Interrupt agent", exact: true })).toHaveCount(
        0,
      );

      gate.releaseHeldClientRequest();
    } finally {
      gate.restore();
      await agent.cleanup();
    }
  });

  test("makes the next queued turn interruptible after cancellation settles", async ({ page }) => {
    const title = "Queued turn after interrupt";
    const secondPrompt = "Run the queued turn after interruption.";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "submission-queued-after-interrupt-",
      title,
      model: "one-minute-stream",
    });
    try {
      const gate = await installDaemonWebSocketGate(page);
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await submitMessage(page, "Keep running until the queued turn is ready.");
      await expectAgentReadyToInterrupt(page);
      await queueMessage(page, secondPrompt);
      await expect(page.getByRole("button", { name: "Send queued message now" })).toBeVisible();

      gate.holdNextServerMessage("cancel_agent_response");
      await page.getByRole("button", { name: "Stop agent", exact: true }).click();
      await gate.waitForHeldServerMessage();

      await expect(page.getByTestId("user-message").filter({ hasText: secondPrompt })).toHaveCount(
        1,
      );
      await expectRunningAgentChrome(page, title);
      await expectAgentReadyToInterrupt(page);

      gate.holdNextClientRequest("cancel_agent_request");
      await page.getByRole("button", { name: "Stop agent", exact: true }).click();
      await gate.waitForHeldClientRequest();
      await expect(
        page.getByRole("button", { name: "Canceling agent", exact: true }),
      ).toBeVisible();

      gate.releaseHeldServerMessage();
      await expect(
        page.getByRole("button", { name: "Canceling agent", exact: true }),
      ).toBeVisible();
      gate.releaseHeldClientRequest();
      await expectVisibleAgentSurfacesIdle(page);
    } finally {
      await agent.cleanup();
    }
  });

  test("shows every agent surface idle after interrupting a submitted turn", async ({ page }) => {
    const title = "Interrupted submission";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "submission-interrupt-",
      title,
      model: "one-minute-stream",
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await submitMessage(page, "Interrupt this submitted turn.");
      await expectRunningAgentChrome(page, title);

      await cancelAgent(page);

      await expectAgentSurfacesIdle(page, title);
    } finally {
      await agent.cleanup();
    }
  });

  test("reconciles every agent surface when interrupt completion is missed", async ({ page }) => {
    const gate = await installDaemonWebSocketGate(page);
    const title = "Missed interrupt completion";
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "submission-missed-interrupt-",
      title,
      model: "one-minute-stream",
    });
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      await submitMessage(page, "Interrupt without delivering the terminal event.");
      await expectRunningAgentChrome(page, title);
      gate.setAgentStreamEventSuppressed("turn_canceled", true);

      await cancelAgent(page);
      await gate.waitForAgentStreamEvent("turn_canceled");
      await agent.client.waitForFinish(agent.agentId, 30_000);

      await expectAgentSurfacesIdle(page, title);
    } finally {
      gate.setAgentStreamEventSuppressed("turn_canceled", false);
      await agent.cleanup();
    }
  });

  test("keeps layout stable when submitting to an agent with existing history", async ({
    page,
    submissionScenario,
  }) => {
    const prompt = "Hold this submission.";
    const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
    await composer.fill(prompt);
    await expect(composer).toHaveValue(prompt);
    await expect(
      page.getByTestId("user-message").filter({ hasText: submissionScenario.existingPrompt }),
    ).toBeVisible();
    const finishTimelineRowStabilityCheck = await beginTimelineRowStabilityCheck(
      page,
      page.getByTestId("assistant-message").last(),
    );
    const assistantMessageCount = await page.getByTestId("assistant-message").count();
    const toolCallCount = await page.getByTestId("tool-call-badge").count();
    await composer.press("Enter");
    const userMessage = page.getByTestId("user-message").filter({ hasText: prompt }).last();
    await expect(userMessage).toBeVisible();
    await expect
      .poll(async () => page.getByTestId("assistant-message").count())
      .toBeGreaterThan(assistantMessageCount);
    await expect
      .poll(async () => page.getByTestId("tool-call-badge").count())
      .toBeGreaterThan(toolCallCount);
    await finishTimelineRowStabilityCheck();
  });

  test("keeps the submitted row stable through draft create handoff", async ({
    page,
    draftCreateScenario,
  }) => {
    test.setTimeout(120_000);
    const pending = await beginDraftCreateSubmission(page, draftCreateScenario);
    await completeDraftCreateSubmission(page, draftCreateScenario, pending);
  });

  test("restores a rejected submission and accepts its retry", async ({
    page,
    rejectionScenario,
  }) => {
    const prompt = "Restore this rejected submission.";
    await submitMessageThatWillBeRejected(page, prompt);
    await expectRejectedSubmissionRestored(page, { prompt, ...rejectionScenario });
    await retryRestoredSubmission(page, prompt);
  });

  test("restores overlapping queued sends when their connection fails", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const gate = await gateNextAgentMessage(page);
    const agent = await startRunningMockAgent(page, {
      prefix: `overlapping-queued-send-${testInfo.workerIndex}-`,
      model: "one-minute-stream",
      prompt: "Keep the agent running while messages queue.",
    });
    const prompts = ["Restore the first queued send.", "Restore the second queued send."];
    try {
      await queueMessage(page, prompts[0]);
      await queueMessage(page, prompts[1]);
      await page.getByRole("button", { name: "Send queued message now" }).first().click();
      await gate.waitForRequest(1);
      await page.getByRole("button", { name: "Send queued message now" }).first().click();
      await gate.waitForRequest(2);
      await gate.disconnect();
      await expectQueuedSendFailuresRestored(page, prompts);
    } finally {
      await agent.cleanup();
    }
  });

  test("does not accept a failed submission from an unrelated running turn", async ({
    page,
    unrelatedRunningScenario,
  }) => {
    const prompt = "Restore this unsent prompt.";
    await submitMessageThatWillBeRejected(page, prompt);
    await unrelatedRunningScenario.gate.waitForRequest();
    await unrelatedRunningScenario.agent.client.sendAgentMessage(
      unrelatedRunningScenario.agent.agentId,
      "Start an unrelated turn.",
    );
    await expect(
      page.getByTestId("user-message").filter({ hasText: "Start an unrelated turn." }),
    ).toBeVisible();
    await unrelatedRunningScenario.gate.disconnect();
    await expectFailedSubmissionRestored(page, prompt);
  });

  test("keeps a submitted prompt before its response when canonical history arrives", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await expectInterruptedTurnOrderAfterReconnect(page, testInfo);
  });

  test("keeps a streaming hidden submission before its output after workspace eviction", async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await expectHiddenStreamingSubmissionOrderAfterWorkspaceEviction(page, testInfo);
  });

  test("clears an attachment-only submission when canonical history arrives after a missed running transition", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await expectCompletedSubmissionClearsAfterMissedRunningTransition(page, testInfo);
  });

  test("clears a provider acknowledgement that arrives before RPC acceptance", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await expectProviderAcknowledgementBeforeRpcAcceptanceSettlesSubmission(page, testInfo);
  });

  test("keeps an old-daemon replacement answer after its interrupted prompt", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await expectLegacyAssistantStartsAfterInterruptedPrompt(page, testInfo);
  });

  test("preserves newer live output when a stale canonical page arrives", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await expectStaleCanonicalPagePreservesNewerLiveOutput(page, testInfo);
  });

  test("uses canonical order when another client turn overtakes a held submission", async ({
    page,
  }, testInfo) => {
    await expectCanonicalOrderWinsAcrossOverlappingClients(page, testInfo);
  });

  test("keeps a daemon-handled submitted row after authoritative reload", async ({
    page,
  }, testInfo) => {
    await expectDaemonHandledSubmissionSurvivesReload(page, testInfo);
  });

  test("uses untracked optimistic rows for an old host", async ({ page }, testInfo) => {
    await expectOldHostSubmissionBehavior(page, testInfo);
  });
});
