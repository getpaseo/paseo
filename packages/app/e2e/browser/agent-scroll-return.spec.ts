import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import {
  readScrollMetrics,
  scrollChatAwayFromBottom,
} from "../support/helpers/agent-bottom-anchor";
import { getServerId } from "../support/helpers/server-id";
import { seedMockAgentWorkspace, type MockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  continueToNextQuestion,
  fillQuestionAnswer,
  submitQuestionAnswers,
  waitForQuestionPrompt,
} from "../support/helpers/questions";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";
import {
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";
import { openSettings } from "../support/helpers/app";
import { openSettingsSection } from "../support/helpers/settings";
import {
  failPromptIndexResponses,
  trackPromptJumpRequests,
} from "../support/helpers/agent-timeline-gate";

async function chooseChatOpenPosition(page: Page, position: "Start" | "End") {
  await openSettings(page);
  await openSettingsSection(page, "chat");
  await page.getByRole("button", { name: /^Open chat at:/ }).click();
  await page.getByRole("menuitem", { name: `${position} of conversation`, exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Open chat at: ${position} of conversation`, exact: true }),
  ).toBeVisible();
}

test("chat open position persists and opens unloaded history without following new output", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const agent = await seedLongMockAgentTimeline({ turns: 80 });
  const backgroundPrompt = "New output while reading the beginning";
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, agent.newestPrompt);
    await expectChatAtBottom(page);
    await chooseChatOpenPosition(page, "Start");
    // Opening at the beginning must also work with the outline hidden.
    await page.getByRole("switch", { name: "Chat outline", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Chat outline", exact: true })).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("chat-open-position-setting.png") });
    const jumps = await trackPromptJumpRequests(page, agent.agentId);
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, agent.oldestPrompt);
    await expect(page.getByTestId("chat-outline-rail")).toBeHidden();
    await expect.poll(() => jumps.requests().length).toBe(1);
    expect(jumps.requests()[0]).toMatchObject({ limit: 40, mergeWindow: true });
    await page.reload();
    await expectTimelinePromptVisible(page, agent.oldestPrompt);
    await agent.client.sendAgentMessage(agent.agentId, backgroundPrompt);
    await agent.client.waitForFinish(agent.agentId, 20_000);
    await expectTimelinePromptVisible(page, agent.oldestPrompt);
    await page.screenshot({ path: testInfo.outputPath("chat-open-position-start.png") });
    await page.getByTestId("scroll-to-bottom-button").click();
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
    await chooseChatOpenPosition(page, "End");
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await agent.cleanup();
  }
});

test("chat open position applies when returning through the compact sidebar", async ({ page }) => {
  test.setTimeout(240_000);
  const agent = await seedLongMockAgentTimeline({ turns: 30 });
  const other = await seedMockAgentWorkspace({
    repoPrefix: "chat-open-position-other-",
    title: "Other chat",
    initialPrompt: "Other workspace",
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, agent.newestPrompt);
    await chooseChatOpenPosition(page, "Start");
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, agent.oldestPrompt);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("scroll-to-bottom-button").click();
    await expectChatAtBottom(page);
    await openCompactWorkspace(page, other);
    await openCompactWorkspace(page, agent);
    await expectTimelinePromptVisible(page, agent.oldestPrompt);
  } finally {
    await Promise.allSettled([agent.cleanup(), other.cleanup()]);
  }
});

test("chat open position exposes a failed history jump and retries", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const agent = await seedLongMockAgentTimeline({ turns: 30 });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, agent.newestPrompt);
    await chooseChatOpenPosition(page, "Start");
    const failure = await failPromptIndexResponses(page);
    await openAgentTimeline(page, agent);
    const error = page.getByTestId("chat-open-start-error");
    await expect(error).toContainText("Couldn't open the start of this conversation");
    await page.screenshot({ path: testInfo.outputPath("chat-open-position-retry.png") });
    failure.recover();
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expectTimelinePromptVisible(page, agent.oldestPrompt);
    await expect(error).toBeHidden();
  } finally {
    await agent.cleanup();
  }
});

async function expectChatAtBottom(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readScrollMetrics(page)).distanceFromBottom, {
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(72);
}

async function openCompactWorkspace(
  page: Page,
  workspace: Pick<MockAgentWorkspace, "workspaceId">,
): Promise<void> {
  await openMobileAgentSidebar(page);
  await switchWorkspaceViaSidebar({
    page,
    serverId: getServerId(),
    workspaceId: workspace.workspaceId,
  });
}

function armDelayedScrollForHiddenChat(page: Page): Promise<void> {
  return page
    .locator('[data-testid="agent-chat-scroll"]:visible')
    .first()
    .evaluate((root) => {
      const scroll = root as HTMLElement;
      return new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
          if (scroll.getClientRects().length > 0) return;
          observer.disconnect();
          scroll.dispatchEvent(new Event("scroll"));
          resolve();
        });
        observer.observe(scroll);
      });
    });
}

test("pointer jitter cannot turn geometry changes into scroll intent", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const backgroundPrompt = "Continue after a pointer is released outside the chat";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
    const bounds = await scroll.boundingBox();
    expect(bounds, "Expected visible chat scroll bounds").not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2 - 3);
    await page.setViewportSize({ width: 390, height: 1124 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.mouse.move(410, bounds!.y + bounds!.height / 2 - 3);
    await page.mouse.up();

    await longChat.client.sendAgentMessage(longChat.agentId, backgroundPrompt);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await longChat.cleanup();
  }
});

test("a retained chat ignores delayed scroll delivery while hidden", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-hidden-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });
  const backgroundPrompt = "emit 500 coalesced agent stream updates";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    const delayedScrollDelivered = armDelayedScrollForHiddenChat(page);
    await openCompactWorkspace(page, otherWorkspace);
    await delayedScrollDelivered;
    await longChat.client.sendAgentMessage(longChat.agentId, backgroundPrompt);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);

    await openCompactWorkspace(page, longChat);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("a retained streaming chat returns to the bottom and continues following", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-streaming-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });
  const streamingPrompt = "Continue streaming while this workspace is hidden";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    await longChat.client.sendAgentMessage(longChat.agentId, streamingPrompt);
    await longChat.client.waitForAgentUpsert(
      longChat.agentId,
      (snapshot) => snapshot.status === "running",
      15_000,
    );
    await openCompactWorkspace(page, otherWorkspace);
    await openCompactWorkspace(page, longChat);

    await expectTimelinePromptVisible(page, streamingPrompt);
    await expectChatAtBottom(page);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);
    await expectChatAtBottom(page);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("a retained chat preserves an intentional reading position", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-reading-position-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    const readingPosition = await scrollChatAwayFromBottom(page, {
      deltaY: -900,
      minDistanceFromBottom: 300,
    });

    await openCompactWorkspace(page, otherWorkspace);
    await openCompactWorkspace(page, longChat);

    await expect
      .poll(async () => Math.abs((await readScrollMetrics(page)).offsetY - readingPosition.offsetY))
      .toBeLessThanOrEqual(24);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("editing keys in an embedded question keep output following", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const questionPrompt = "Emit synthetic questions: two free-write questions.";
  const firstQuestion = "What is the GitHub private repo URL to push to?";
  const secondQuestion = "What should the first commit message be?";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    await longChat.client.sendAgentMessage(longChat.agentId, questionPrompt);
    await waitForQuestionPrompt(page, 30_000);
    await fillQuestionAnswer(page, {
      question: firstQuestion,
      answer: "git@github.com:user/private-repo.git",
    });
    const firstInput = page
      .getByTestId("question-form-card")
      .first()
      .getByRole("textbox", { name: firstQuestion });
    const inputBounds = await firstInput.boundingBox();
    expect(inputBounds, "Expected embedded question input bounds").not.toBeNull();
    await page.mouse.move(
      inputBounds!.x + inputBounds!.width / 2,
      inputBounds!.y + inputBounds!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      inputBounds!.x + inputBounds!.width / 2 + 20,
      inputBounds!.y + inputBounds!.height / 2 - 3,
    );
    await page.mouse.up();
    await firstInput.press("Home");
    await firstInput.press("ArrowUp");
    await continueToNextQuestion(page);
    await fillQuestionAnswer(page, {
      question: secondQuestion,
      answer: "Initialize private repo",
    });
    await submitQuestionAnswers(page);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);

    await expectChatAtBottom(page);
  } finally {
    await longChat.cleanup();
  }
});
