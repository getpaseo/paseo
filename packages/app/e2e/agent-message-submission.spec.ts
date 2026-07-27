import type { Locator, Page } from "@playwright/test";
import { expect, test as baseTest } from "./fixtures";
import { expectAgentIdle } from "./helpers/agent-stream";
import { gateNextAgentMessage } from "./helpers/agent-message-gate";
import {
  attachImageFromMenu,
  expectComposerDraft,
  expectComposerEditable,
  expectAttachmentPill,
  expectComposerVisible,
  fillComposerDraft,
  sendDraftToQueue,
  startRunningMockAgent,
} from "./helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import { readScrollMetrics } from "./helpers/agent-bottom-anchor";
import { seedWorkspace } from "./helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import { getServerId } from "./helpers/server-id";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { delayBrowserAgentCreatedStatus } from "./helpers/new-workspace";
import { installDaemonWebSocketGate } from "./helpers/daemon-websocket-gate";

const IMAGE = {
  name: "message-submission.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
};

interface MessageGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SubmissionScenario {
  gate: Awaited<ReturnType<typeof gateNextAgentMessage>>;
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
    const gate = await gateNextAgentMessage(page);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: `message-submission-${testInfo.workerIndex}-`,
      title: "Message submission regression",
      model: "ten-second-stream",
    });
    await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
    await expectComposerVisible(page);
    await expectAgentIdle(page);
    await provide({ gate });
    await agent.cleanup();
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

async function readMessageGeometry(page: Page, userMessage: Locator): Promise<MessageGeometry> {
  const box = await userMessage.boundingBox();
  if (!box) throw new Error("Submitted user message has no browser geometry");
  const { offsetY } = await readScrollMetrics(page);
  return { x: box.x, y: box.y + offsetY, width: box.width, height: box.height };
}

async function beginWorkingFooterContinuityCheck(page: Page): Promise<() => Promise<void>> {
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await page.evaluate(() => {
    const state = { active: true, sawMissing: false };
    const windowState = window as unknown as Record<string, unknown>;
    windowState.__messageSubmissionFooterContinuity = state;
    const checkFrame = () => {
      if (!state.active) return;
      if (!document.querySelector('[data-testid="turn-working-indicator"]')) {
        state.sawMissing = true;
      }
      requestAnimationFrame(checkFrame);
    };
    requestAnimationFrame(checkFrame);
  });

  return async () => {
    const sawMissing = await page.evaluate(() => {
      const windowState = window as unknown as Record<string, unknown>;
      const state = windowState.__messageSubmissionFooterContinuity as
        | { active: boolean; sawMissing: boolean }
        | undefined;
      if (!state) throw new Error("Working-footer continuity check was not started");
      state.active = false;
      delete windowState.__messageSubmissionFooterContinuity;
      return state.sawMissing;
    });
    expect(sawMissing).toBe(false);
  };
}

async function expectAcceptedSubmission(
  page: Page,
  userMessage: Locator,
  submittedGeometry: MessageGeometry,
): Promise<void> {
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await expect(userMessage).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  expect(await readMessageGeometry(page, userMessage)).toEqual(submittedGeometry);
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
  submittedGeometry: MessageGeometry,
): Promise<void> {
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await expect(page.getByTestId(/^workspace-tab-agent_/).first()).toBeVisible({ timeout: 30_000 });
  await expect(userMessage).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await expect(page.getByTestId("user-message").filter({ hasText: prompt })).toHaveCount(1);
  await expect(userMessage.getByRole("button", { name: "Open image attachment" })).toBeVisible();
  expect(await readMessageGeometry(page, userMessage)).toEqual(submittedGeometry);
}

interface DraftCreatePendingSubmission {
  prompt: string;
  userMessage: Locator;
  submittedGeometry: MessageGeometry;
  finishFooterContinuityCheck: () => Promise<void>;
}

async function beginDraftCreateSubmission(
  page: Page,
  scenario: DraftCreateScenario,
): Promise<DraftCreatePendingSubmission> {
  await openWorkspaceDraft(page, scenario.workspaceId);
  const prompt = "Keep this row through create handoff.";
  const userMessage = await submitMessageWithImage(page, prompt);
  await scenario.agentCreatedDelay.waitForCreateRequest();
  await scenario.agentCreatedDelay.waitForDelayedCreatedStatus();
  await expectPendingSubmission(page, userMessage);
  const submittedGeometry = await readMessageGeometry(page, userMessage);
  const finishFooterContinuityCheck = await beginWorkingFooterContinuityCheck(page);
  return { prompt, userMessage, submittedGeometry, finishFooterContinuityCheck };
}

async function completeDraftCreateSubmission(
  page: Page,
  scenario: DraftCreateScenario,
  pending: DraftCreatePendingSubmission,
): Promise<void> {
  scenario.agentCreatedDelay.release();
  await expectCreatedAgentHandoff(
    page,
    pending.prompt,
    pending.userMessage,
    pending.submittedGeometry,
  );
  await pending.finishFooterContinuityCheck();
}

test.describe("Agent message submission", () => {
  test("keeps the submitted row stable when the host accepts", async ({
    page,
    submissionScenario,
  }) => {
    const userMessage = await submitMessageWithImage(page, "Hold this submission.");
    await expectPendingSubmission(page, userMessage);
    await submissionScenario.gate.waitForRequest();
    const submittedGeometry = await readMessageGeometry(page, userMessage);
    const finishFooterContinuityCheck = await beginWorkingFooterContinuityCheck(page);
    submissionScenario.gate.accept();
    await expectAcceptedSubmission(page, userMessage, submittedGeometry);
    await finishFooterContinuityCheck();
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
});
