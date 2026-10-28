import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import path from "node:path";
import {
  holdOlderHistoryPages,
  userScrollsTimelineToHistoryStart,
} from "../support/helpers/timeline-pagination";
import { getActiveTabTestId } from "../support/helpers/launcher";
import type { Page, Locator } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        codex: {
          enabled: true,
          command: [process.execPath, path.resolve("e2e/fixtures/catalog-codex.mjs")],
        },
      },
    },
  },
});

type ChatDisplay = "full" | "collapseToolCalls" | "collapseTurns";

async function useChatDisplay(page: Page, chatDisplay: ChatDisplay): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ chatDisplay: value }));
  }, chatDisplay);
}

async function seedAnsweredAgent(title: string) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "turn-collapse-",
    title,
    model: "ten-second-stream",
    initialPrompt: "Why does the chat stop following new output?",
  });
  await agent.client.waitForFinish(agent.agentId, 30_000);
  await agent.client.sendAgentMessage(
    agent.agentId,
    "Make the fix and run the burst script.\n" + "Keep the previous response visible.\n".repeat(40),
  );
  await agent.client.waitForFinish(agent.agentId, 30_000);
  return agent;
}

/** Chat rows between the latest turn's summary line and its reply, in document order. */
async function rowsBetweenLatestSummaryAndReply(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-message-id]")];
    const summaryRow = rows.findLastIndex((row) => row.querySelector("[data-testid=turn-summary]"));
    const replyRow = rows.findLastIndex((row) =>
      row.querySelector("[data-testid=assistant-message]"),
    );
    return replyRow - summaryRow - 1;
  });
}

async function groupedToolsInsideLatestTurn(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-message-id]")];
    const start = rows.findLastIndex((row) => row.querySelector("[data-testid=turn-summary]"));
    const end = rows.findLastIndex((row) => row.querySelector("[data-testid=assistant-message]"));
    return rows
      .slice(start + 1, end)
      .flatMap((row) =>
        [...row.querySelectorAll("[data-testid=tool-call-group]")].map(
          (group) => group.textContent ?? "",
        ),
      );
  });
}

async function expectCompactMessageToggle(prompt: Locator, label: string) {
  const button = prompt.getByRole("button", { name: label, exact: true });
  const text = prompt.getByText(label, { exact: true });
  await expect
    .poll(
      async () => {
        const control = (await button.boundingBox())!;
        const glyphs = (await text.boundingBox())!;
        return control.height - glyphs.height;
      },
      { message: "The inline toggle adds no vertical space beyond its text" },
    )
    .toBe(0);
}

async function expandAndCollapseLongPrompt(page: Page) {
  const prompt = page.getByTestId("user-message").last();
  const before = await prompt.boundingBox();
  const text = prompt.locator('[data-message-text="true"]');
  const messageLeft = (await text.boundingBox())!.x;
  await expect
    .poll(async () => (await prompt.getByText("Show more", { exact: true }).boundingBox())!.x)
    .toBe(messageLeft);
  await expectCompactMessageToggle(prompt, "Show more");
  await prompt.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(prompt.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
  await expect
    .poll(async () => (await prompt.getByText("Show less", { exact: true }).boundingBox())!.x)
    .toBe(messageLeft);
  await expect
    .poll(async () => (await prompt.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before!.height);
  await expectCompactMessageToggle(prompt, "Show less");
  await prompt.getByRole("button", { name: "Show less", exact: true }).click();
  await expect.poll(async () => (await prompt.boundingBox())?.height ?? 0).toBe(before!.height);
  await prompt.scrollIntoViewIfNeeded();
  const bounds = (await prompt.boundingBox())!;
  const body = (await text.boundingBox())!;
  await page.screenshot({
    path: "/tmp/message-toggle-aligned.png",
    clip: {
      x: body.x - 16,
      y: bounds.y,
      width: bounds.x + bounds.width - body.x + 16,
      height: bounds.height,
    },
  });
}

test.describe("Turn collapse", () => {
  test("folds each answered turn behind a summary line that opens it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await useChatDisplay(page, "collapseTurns");
    const agent = await seedAnsweredAgent("Turn collapse");
    try {
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);

      await expandAndCollapseLongPrompt(page);

      const summary = page.getByTestId("turn-summary").last().getByRole("button");
      await expect(summary).toHaveText(/^Edited 1 file/);
      // Text chunks that stream back to back merge into one message, so the reply holds
      // at least the stream's last chunk.
      await expect(page.getByTestId("assistant-message").last()).toHaveText(
        /\(end of synthetic stream\)$/,
      );
      await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(0);

      await summary.click();
      await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBeGreaterThan(0);
      await expect(summary).toBeInViewport();
      await summary.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.screenshot({ path: "/tmp/turn-rail-aligned.png" });
      await expect.poll(() => groupedToolsInsideLatestTurn(page)).toEqual([]);

      await summary.click();
      await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(0);
    } finally {
      await agent.cleanup();
    }
  });
});

test("received messages show their sender and open that agent", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "dark" })),
  );
  const recipient = await seedMockAgentWorkspace({
    repoPrefix: "sender-attribution-",
    title: "Implementation",
  });
  try {
    const sender = await recipient.client.createAgent({
      provider: "codex",
      cwd: recipient.cwd,
      workspaceId: recipient.workspaceId,
      title: "Reviewer",
      model: "gpt-6.1-sol",
      modeId: "full-access",
    });
    await recipient.client.sendAgentMessage(
      recipient.agentId,
      "I reviewed the turn-grouping changes. Heartbeats now keep their own timing footer, and the previous response stays visible.",
      { sourceAgentId: sender.id },
    );
    await openAgentRoute(page, recipient);
    await expectComposerVisible(page);
    const attribution = page.getByRole("button", { name: "Sent by Reviewer", exact: true });
    await expect(attribution).toBeVisible();
    await expect(page.getByTestId("user-message").filter({ has: attribution })).toContainText(
      "I reviewed the turn-grouping changes.",
    );
    const labelColor = await attribution
      .getByText("Sent by Reviewer", { exact: true })
      .evaluate((element) => getComputedStyle(element).color);
    await expect(attribution.locator("svg")).toHaveCSS("fill", labelColor);
    await expectSenderAlignedWithBubble(attribution);
    await attribution.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/sender-attribution.png" });
    await attribution.click();
    await expect.poll(() => getActiveTabTestId(page)).toContain(sender.id);
  } finally {
    await recipient.cleanup();
  }
});

test("long sender attribution stays on one line in compact chat", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() =>
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "dark" })),
  );
  const recipient = await seedMockAgentWorkspace({
    repoPrefix: "compact-attribution-",
    title: "Implementation",
  });
  try {
    const title = "Reviewer checking the compact chat timeline and sender attribution";
    const sender = await recipient.client.createAgent({
      provider: "codex",
      cwd: recipient.cwd,
      workspaceId: recipient.workspaceId,
      title,
      model: "gpt-6.1-sol",
      modeId: "full-access",
    });
    await recipient.client.sendAgentMessage(
      recipient.agentId,
      "The sender label stays on one line, even when the agent has a long name.",
      { sourceAgentId: sender.id },
    );
    await openAgentRoute(page, recipient);
    await expectComposerVisible(page);
    const attribution = page.getByRole("button", { name: `Sent by ${title}`, exact: true });
    await expect(attribution).toBeVisible();
    await expectSenderTruncatedWithinMessage(attribution, title);
    await expectSenderAlignedWithBubble(attribution);
    await attribution.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("sender-compact-390.png") });
    await page.setViewportSize({ width: 320, height: 740 });
    await expectSenderTruncatedWithinMessage(attribution, title);
    await expectSenderAlignedWithBubble(attribution);
    await page.screenshot({ path: testInfo.outputPath("sender-compact-320.png") });
  } finally {
    await recipient.cleanup();
  }
});

interface MessagePreviewWatch {
  /** Frames after the watch started on which the fade or "Show more" control was missing. */
  framesWithoutClip: number[];
  /** Frames on which the fade was a different DOM node than when the watch started. */
  framesRemounted: number[];
}

declare global {
  interface Window {
    __paseoMessagePreviewWatch?: { stop(): MessagePreviewWatch };
  }
}

async function seedReceivedReviewWithToolTurn() {
  const recipient = await seedMockAgentWorkspace({
    repoPrefix: "preview-clip-",
    title: "Implementation",
  });
  const sender = await recipient.client.createAgent({
    provider: "mock",
    cwd: recipient.cwd,
    workspaceId: recipient.workspaceId,
    title: "Reviewer",
    modeId: "load-test",
    model: "e2e-fast-stream",
  });
  // Long enough to clip behind the preview fade; the instruction makes the recipient run tools.
  await recipient.client.sendAgentMessage(
    recipient.agentId,
    "Review complete: the regression is red on the baseline and green with the fix.\n" +
      "Keep the previous response visible while the reader scrolls.\n".repeat(30) +
      "Now emit 7 tool agent stream updates",
    { sourceAgentId: sender.id },
  );
  return recipient;
}

/** Samples the received message's bubble on every animation frame until stopped. */
async function watchReceivedMessagePreview(page: Page, senderLabel: string): Promise<void> {
  await page.evaluate((label) => {
    const findBubble = () =>
      [...document.querySelectorAll("[data-testid=user-message]")].find((row) =>
        row.textContent?.includes(label),
      ) ?? null;
    const initialFade = findBubble()?.querySelector("svg") ?? null;
    if (!initialFade) throw new Error(`No faded bubble for ${label}`);
    const framesWithoutClip: number[] = [];
    const framesRemounted: number[] = [];
    let frame = 0;
    let running = true;
    const sample = () => {
      if (!running) return;
      const bubble = findBubble();
      const fade = bubble?.querySelector("svg") ?? null;
      if (!fade || !bubble?.textContent?.includes("Show more")) framesWithoutClip.push(frame);
      else if (fade !== initialFade) framesRemounted.push(frame);
      frame += 1;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__paseoMessagePreviewWatch = {
      stop() {
        running = false;
        return { framesWithoutClip, framesRemounted };
      },
    };
  }, senderLabel);
}

async function expectReceivedMessagePreviewUndisturbed(page: Page): Promise<void> {
  // Give the opened turn's layout a few frames to settle before judging.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const watch = await page.evaluate(() => window.__paseoMessagePreviewWatch!.stop());
  expect(
    watch.framesWithoutClip,
    "the preview fade and Show more control stay on every frame",
  ).toEqual([]);
  expect(watch.framesRemounted, "the preview keeps its DOM node (no remount)").toEqual([]);
}

// Opening a turn must not rebuild its host row: the preview above the summary loses its
// measured height when remounted, which drops the fade and "Show more" for a frame.
test("opening a turn keeps the received message above it clipped on every frame", async ({
  page,
}) => {
  await useChatDisplay(page, "collapseTurns");
  const recipient = await seedReceivedReviewWithToolTurn();
  try {
    await openAgentRoute(page, recipient);
    await expectComposerVisible(page);
    await expect(page.getByText("Completed 7 commands", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const bubble = page
      .getByTestId("user-message")
      .filter({ has: page.getByRole("button", { name: "Sent by Reviewer", exact: true }) });
    await expect(bubble.getByRole("button", { name: "Show more", exact: true })).toBeVisible();
    await bubble.scrollIntoViewIfNeeded();

    await watchReceivedMessagePreview(page, "Sent by Reviewer");
    await page
      .getByTestId("turn-summary")
      .getByRole("button", { name: "Ran 7 commands", exact: true })
      .click();
    await expect(page.getByText("echo stress-6", { exact: true })).toBeVisible();
    await expectReceivedMessagePreviewUndisturbed(page);
  } finally {
    await recipient.cleanup();
  }
});

async function expectSenderTruncatedWithinMessage(attribution: Locator, title: string) {
  const label = attribution.getByText(`Sent by ${title}`, { exact: true });
  await expect(label).toHaveCSS("white-space", "nowrap");
  await expect(label).toHaveCSS("text-overflow", "ellipsis");
  const bounds = await label.evaluate((element) => ({
    textWidth: element.scrollWidth,
    visibleWidth: element.clientWidth,
    right: element.getBoundingClientRect().right,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(bounds.textWidth).toBeGreaterThan(bounds.visibleWidth);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
}

async function expectSenderAlignedWithBubble(attribution: Locator) {
  const edges = await attribution.evaluate((button) => {
    const bubble = button.nextElementSibling;
    const label = button.querySelector('[dir="auto"]');
    if (!bubble || !label) throw new Error("Sender label or message bubble missing");
    return {
      labelRight: label.getBoundingClientRect().right,
      bubbleRight: bubble.getBoundingClientRect().right,
    };
  });
  expect(
    Math.abs(edges.labelRight - edges.bubbleRight),
    "sender and bubble share the right edge",
  ).toBeLessThanOrEqual(1);
}

async function seedWholeTurnHistory() {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "whole-turn-history-",
    title: "Whole turns",
    model: "e2e-fast-stream",
  });
  for (const prompt of [
    ...Array.from(
      { length: 25 },
      (_, index) => `Short ${index}: emit 1 coalesced agent stream updates`,
    ),
    "Older long turn: emit 60 tool agent stream updates",
    "Latest long turn: emit 120 tool agent stream updates",
  ]) {
    await agent.client.sendAgentMessage(agent.agentId, prompt);
    await agent.client.waitForFinish(agent.agentId, 15_000);
  }
  return agent;
}

test("loads complete long turns and preserves expansion while revealing older history", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await useChatDisplay(page, "collapseTurns");
  const agent = await seedWholeTurnHistory();
  try {
    const history = await holdOlderHistoryPages(page, agent);
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    const latest = page
      .getByTestId("turn-summary")
      .getByRole("button", { name: "Ran 120 commands", exact: true });
    await expect(latest).toBeVisible();
    await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(0);
    await latest.click();
    await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(120);
    await userScrollsTimelineToHistoryStart(page);
    await history.expectRequestedPages(1);
    history.releasePage(1);
    await expect(
      page
        .getByTestId("turn-summary")
        .getByRole("button", { name: "Ran 60 commands", exact: true }),
    ).toBeVisible();
    await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(120);
    history.expectNoRepeatedEntries();
    await latest.scrollIntoViewIfNeeded();
    await latest.click();
    await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(0);
  } finally {
    await agent.cleanup();
  }
});

async function useThinkingDisplay(
  page: Page,
  autoExpandReasoning: boolean,
  chatDisplay: ChatDisplay,
) {
  await page.addInitScript(
    (settings) => {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({
          ...settings,
          chatDisplay: sessionStorage.getItem("e2e-chat-display") ?? settings.chatDisplay,
        }),
      );
    },
    { autoExpandReasoning, chatDisplay },
  );
}

for (const autoExpandReasoning of [false, true]) {
  test(`reasoning follows Expand thinking (${autoExpandReasoning}) when opening its turn`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await useThinkingDisplay(page, autoExpandReasoning, "collapseToolCalls");
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "thinking-group-",
      title: "Thinking with tools",
      model: "ten-second-stream",
      initialPrompt: "Inspect the scroll container",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, agent);
      await expectComposerVisible(page);
      const reasoning = page
        .getByText(/Need to find the scroll container, the layout effect/)
        .filter({ visible: true })
        .first();
      await expectThinkingPresentation(page, autoExpandReasoning);
      await switchToCollapsedTurns(page);
      await expectComposerVisible(page);
      const summary = page.getByTestId("turn-summary").last().getByRole("button");
      await expect(summary).toBeVisible();
      await expect(summary).not.toContainText(/thought/i);
      await expect(reasoning).toHaveCount(0);
      await summary.click();
      await expect(reasoning).toHaveCount(autoExpandReasoning ? 1 : 0);
      await expect.poll(() => groupedToolsInsideLatestTurn(page)).toEqual([]);
      await openOneToolOutput(page);
      await summary.click();
      await expect(reasoning).toHaveCount(0);
    } finally {
      await agent.cleanup();
    }
  });
}

async function openOneToolOutput(page: Page) {
  const output = page.getByText(/\[burst\] tick 1 userIsAtBottom=true/).filter({ visible: true });
  await expect(output).toHaveCount(0);
  const command = page
    .getByTestId("tool-call-badge")
    .filter({ hasText: "node scripts/simulate-stream-burst.mjs" })
    .first();
  await command.getByRole("button").first().click();
  await expect(output.first()).toBeVisible();
  await command.getByRole("button").first().click();
  await expect(output).toHaveCount(0);
}

async function expectThinkingPresentation(page: Page, autoExpandReasoning: boolean) {
  const reasoning = page
    .getByText(/Need to find the scroll container, the layout effect/)
    .filter({ visible: true })
    .first();
  if (autoExpandReasoning) {
    await expect(reasoning).toBeVisible();
    await expect(page.getByTestId("tool-call-group").filter({ hasText: /thought/ })).toHaveCount(0);
  } else {
    await expect(reasoning).toHaveCount(0);
    const group = page
      .getByTestId("tool-call-group")
      .filter({ hasText: /read 1 file/i, visible: true })
      .last();
    await expect(group).toContainText(/read 1 file/i);
    await expect(group.getByRole("button").first()).not.toContainText(/thought/i);
    await group.getByRole("button").first().click();
    // Expand thinking is off: the group opens its rows, but the thought row stays closed
    // until the reader opens it.
    const thought = group
      .getByTestId("tool-call-badge")
      .filter({ hasText: /^Thinking/ })
      .first();
    await expect(thought).toBeVisible();
    await expect(reasoning).toHaveCount(0);
    // A press right after the group opens occasionally does not register; retry until the
    // thought row opens.
    await expect(async () => {
      await thought.getByRole("button").first().click();
      await expect(reasoning).toBeVisible({ timeout: 2_000 });
    }).toPass();
  }
}

async function switchToCollapsedTurns(page: Page) {
  await page.evaluate(() => {
    sessionStorage.setItem("e2e-chat-display", "collapseTurns");
  });
  await page.reload();
}

test("a scheduled heartbeat opens a separate turn without reopening the previous response", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await useChatDisplay(page, "collapseTurns");
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "heartbeat-turn-",
    title: "Heartbeat turns",
    model: "ten-second-stream",
    initialPrompt: "Inspect the scroll container",
  });
  const schedules = agent.client as unknown as Pick<
    DaemonClient,
    "scheduleCreate" | "scheduleRunOnce" | "scheduleDelete"
  >;
  let scheduleId: string | undefined;
  try {
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);
    const summaries = page.getByTestId("turn-summary");
    await expect(summaries).toHaveCount(1);
    const previousSummary = await summaries.first().innerText();
    const previousReplyId = await page
      .getByTestId("assistant-message")
      .last()
      .evaluate((element) => element.closest("[data-message-id]")!.getAttribute("data-message-id"));
    const created = await schedules.scheduleCreate({
      name: "Check the completed work",
      prompt: "Inspect the scroll container again",
      cadence: { type: "cron", expression: "0 0 1 1 *" },
      target: { type: "self", agentId: agent.agentId },
      runOnCreate: false,
    });
    expect(created.error).toBeNull();
    scheduleId = created.schedule!.id;
    const fired = await schedules.scheduleRunOnce({ id: scheduleId });
    expect(fired.error).toBeNull();
    await expect(
      page.getByTestId("tool-call-badge").filter({ hasText: /^Heartbeat/ }),
    ).toBeVisible();
    await expect(summaries.first()).toHaveText(previousSummary);
    const previousReply = page
      .locator(`[data-message-id="${previousReplyId}"]`)
      .getByTestId("assistant-message");
    await expect(previousReply).toBeVisible();
    await expect(previousReply).toContainText("(end of synthetic stream)");
    await agent.client.waitForFinish(agent.agentId, 30_000);
    await expect(summaries).toHaveCount(2);
    await expect.poll(() => rowsBetweenLatestSummaryAndReply(page)).toBe(0);
    await expect(page.getByRole("button", { name: /^Worked for/ })).toHaveCount(2);
    await page.screenshot({ path: "/tmp/heartbeat-turn-footer.png" });
  } finally {
    if (scheduleId) await schedules.scheduleDelete({ id: scheduleId });
    await agent.cleanup();
  }
});
