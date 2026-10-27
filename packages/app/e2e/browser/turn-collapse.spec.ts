import {
  holdOlderHistoryPages,
  userScrollsTimelineToHistoryStart,
} from "../support/helpers/timeline-pagination";
import { getActiveTabTestId } from "../support/helpers/launcher";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

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

async function expandAndCollapseLongPrompt(page: Page) {
  const prompt = page.getByTestId("user-message").last();
  const before = await prompt.boundingBox();
  const text = prompt.locator('[data-message-text="true"]');
  const messageLeft = (await text.boundingBox())!.x;
  await expect
    .poll(async () => (await prompt.getByText("Show more", { exact: true }).boundingBox())!.x)
    .toBe(messageLeft);
  await prompt.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(prompt.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
  await expect
    .poll(async () => (await prompt.getByText("Show less", { exact: true }).boundingBox())!.x)
    .toBe(messageLeft);
  await expect
    .poll(async () => (await prompt.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before!.height);
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
  const recipient = await seedMockAgentWorkspace({
    repoPrefix: "sender-attribution-",
    title: "Implementation",
  });
  try {
    const sender = await recipient.client.createAgent({
      provider: "mock",
      cwd: recipient.cwd,
      workspaceId: recipient.workspaceId,
      title: "Reviewer",
      model: "e2e-fast-stream",
      modeId: "load-test",
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
    await attribution.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/sender-attribution.png" });
    await attribution.click();
    await expect.poll(() => getActiveTabTestId(page)).toContain(sender.id);
  } finally {
    await recipient.cleanup();
  }
});

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
  test(`reasoning follows Expand thinking (${autoExpandReasoning}) and opens fully with its turn`, async ({
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
      await summary.click();
      await expect(reasoning).toBeVisible();
      await expect.poll(() => groupedToolsInsideLatestTurn(page)).toEqual([]);
    } finally {
      await agent.cleanup();
    }
  });
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
      .filter({ hasText: /thought/, visible: true })
      .last();
    await expect(group).toContainText(/read 1 file/i);
    await group.getByRole("button").first().click();
    await expect(reasoning).toBeVisible();
  }
}

async function switchToCollapsedTurns(page: Page) {
  await page.evaluate(() => {
    sessionStorage.setItem("e2e-chat-display", "collapseTurns");
  });
  await page.reload();
}
