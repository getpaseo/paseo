import type { TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  expectReconnectingToastGone,
  expectReconnectingToastVisible,
} from "../support/helpers/workspace-ui";
import { trackPromptJumpRequests } from "../support/helpers/agent-timeline-gate";
import {
  composerLocator,
  fillComposerDraft,
  expectComposerDraft,
  expectComposerFocused,
} from "../support/helpers/composer";

import { openCommandCenter, closeCommandCenter } from "../support/helpers/command-center";

const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const FILLER = Array.from({ length: 400 }, (_, index) => `filler${index}`).join(" ");
const STREAMED_RESPONSE = [
  "First paragraph with alpha-needle and pair-needle inside.",
  "Second paragraph with beta-needle and pair-needle inside.",
  `Third paragraph ${FILLER}`,
].join("\n\n");

const RESPONSE =
  'İ😀hello **world**; hello *world*.\n\n[hello &amp; world](https://example.com/hidden-destination)\n\n```ts\nconst a = "a.b";\n```\n\n- first cell\n- second cell';

// One message far taller than the viewport, so its first and last paragraph rows are
// never in the virtualizer's window at the same time.
const PARAGRAPH_PADDING = Array.from({ length: 40 }, (_, index) => `padding${index}`).join(" ");
const TALL_RESPONSE = Array.from({ length: 30 }, (_, index) => {
  if (index === 0) return `Opening paragraph with span-needle. ${PARAGRAPH_PADDING}`;
  if (index === 29) return `Closing paragraph with span-needle. ${PARAGRAPH_PADDING}`;
  return `Paragraph ${index}. ${PARAGRAPH_PADDING}`;
}).join("\n\n");

function query(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true });
}
function status(page: Page) {
  return page.getByRole("status", { name: "Find matches" });
}
async function openChatFind(page: Page) {
  await page.getByTestId("assistant-message").filter({ visible: true }).last().click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
}
async function searchChat(page: Page, text: string) {
  await openChatFind(page);
  await query(page).fill(text);
}
async function expectHighlight(page: Page, text: string) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entries = Array.from(CSS.highlights.entries()).filter(([name]) =>
          name.startsWith("paseo-chat-find-"),
        );
        const texts: string[] = [];
        for (const [, highlight] of entries) {
          for (const range of highlight) texts.push(range.toString());
        }
        return texts;
      }),
    )
    .toEqual([text]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entry = Array.from(CSS.highlights.entries()).find(([name]) =>
          name.startsWith("paseo-chat-find-"),
        );
        const range = entry && Array.from(entry[1])[0];
        if (!(range instanceof Range)) return false;
        const rect = range.getBoundingClientRect();
        const row = range.startContainer.parentElement?.closest(
          '[data-testid="agent-chat-scroll"]',
        );
        const viewport = row?.getBoundingClientRect();
        return (
          !!viewport && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
        );
      }),
    )
    .toBe(true);
}
async function nextMatch(page: Page) {
  await query(page).press("Enter");
}
async function previousMatch(page: Page) {
  await query(page).press("Shift+Enter");
}
async function expectFindStatus(page: Page, search: string, matches: string) {
  await query(page).fill(search);
  await expect(status(page)).toHaveText(matches, { timeout: 15_000 });
}
async function expectNextMatch(page: Page, matches: string, highlighted: string) {
  await nextMatch(page);
  await expect(status(page)).toHaveText(matches);
  await expectHighlight(page, highlighted);
}
async function closeFind(page: Page) {
  await query(page).press("Escape");
  await expect(query(page)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(CSS.highlights.keys()).filter((key) => key.startsWith("paseo-chat-find-")),
      ),
    )
    .toEqual([]);
}

test("loads older history through prompt navigation and finds repeated rendered Markdown", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-",
    title: "Chat Find",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    for (let index = 0; index < 45; index++) {
      await agent.client.sendAgentMessage(agent.agentId, `Prompt number ${index}`);
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    const jumps = await trackPromptJumpRequests(page, agent.agentId);
    await openAgentRoute(page, agent);
    await expect(page.getByText("Prompt number 44", { exact: true })).toBeVisible();
    await expect(page.getByText("Prompt number 0", { exact: true })).toHaveCount(0);
    await searchChat(page, "hello world");
    await expectHighlight(page, "hello world");
    await expect(status(page)).toHaveText("1 of 90");
    await page.screenshot({ path: testInfo.outputPath("chat-find-highlight.png") });
    expect(jumps.requests()[0]).toMatchObject({ limit: 40, mergeWindow: true });
    await nextMatch(page);
    await expect(status(page)).toHaveText("2 of 90");
    await expectHighlight(page, "hello world");
    await previousMatch(page);
    await expect(status(page)).toHaveText("1 of 90");
    await query(page).fill("hello & world");
    await expectHighlight(page, "hello & world");
    await query(page).fill("a.b");
    await expectHighlight(page, "a.b");
    await query(page).fill("Prompt number 0");
    await expectHighlight(page, "Prompt number 0");
    await closeFind(page);
  } finally {
    await agent.cleanup();
  }
});

// The scope of the search is the whole chat, so the counter is the position across
// every message that holds a hit, and Next walks off the end of one into the next.
const ACROSS_PROMPT = "Find scope-needle in this chat";
const ACROSS_RESPONSE = "Reply with scope-needle here.\n\nAnd scope-needle again there.";

/** The test id of the message that holds the current match, so it can be watched crossing one. */
async function highlightedMessage(page: Page) {
  return page.evaluate(() => {
    const entry = Array.from(CSS.highlights.entries()).find(([name]) =>
      name.startsWith("paseo-chat-find-"),
    );
    const range = entry && Array.from(entry[1])[0];
    if (!(range instanceof Range)) return null;
    const message = range.startContainer.parentElement?.closest<HTMLElement>(
      '[data-testid="user-message"], [data-testid="assistant-message"]',
    );
    return message?.dataset.testid ?? null;
  });
}
async function expectHighlightedMessage(page: Page, testId: string) {
  await expect.poll(() => highlightedMessage(page)).toBe(testId);
}

test("counts and steps through every match in the chat, not just the selected message", async ({
  page,
}, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-across-",
    title: "Chat Find across messages",
    initialPrompt: ACROSS_PROMPT,
    featureValues: { mockAssistantResponse: ACROSS_RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
    // One hit in the prompt and two in the reply: three across the chat.
    await searchChat(page, "scope-needle");
    await expect(status(page)).toHaveText("1 of 3");
    await expectHighlight(page, "scope-needle");
    await expectHighlightedMessage(page, "user-message");
    await page.screenshot({ path: testInfo.outputPath("chat-find-across-messages.png") });
    await expectNextMatch(page, "2 of 3", "scope-needle");
    await expectHighlightedMessage(page, "assistant-message");
    await expectNextMatch(page, "3 of 3", "scope-needle");
    await expectHighlightedMessage(page, "assistant-message");
    await page.screenshot({ path: testInfo.outputPath("chat-find-last-match.png") });
    await expectNextMatch(page, "1 of 3", "scope-needle");
    await expectHighlightedMessage(page, "user-message");
    await previousMatch(page);
    await expect(status(page)).toHaveText("3 of 3");
    await expectHighlight(page, "scope-needle");
    await expectHighlightedMessage(page, "assistant-message");
    await closeFind(page);
  } finally {
    await agent.cleanup();
  }
});

test("rejects invisible source matches and ignores a late reply after closing", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-cancel-",
    title: "Chat Find cancellation",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    const gate = await installDaemonWebSocketGate(page);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
    await searchChat(page, "hidden-destination");
    await expect(status(page)).toHaveText("No matches");
    await query(page).fill("first cell second cell");
    await expect(status(page)).toHaveText("No matches");
    gate.holdNextServerMessage("agent.timeline.search.response");
    await query(page).fill("hello world");
    await expect(status(page)).toHaveText("Searching…");
    await gate.waitForHeldServerMessage("agent.timeline.search.response");
    await closeFind(page);
    gate.releaseHeldServerMessage("agent.timeline.search.response");
    await searchChat(page, "a.b");
    await expectHighlight(page, "a.b");
    await closeFind(page);
  } finally {
    await agent.cleanup();
  }
});

test("shows a disconnected search failure and recovers with Retry", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-retry-",
    title: "Chat Find retry",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    const gate = await installDaemonWebSocketGate(page);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
    await gate.drop();
    await expectReconnectingToastVisible(page);
    await searchChat(page, "hello world");
    await expect(status(page)).toHaveText("Failed");
    await expect(
      page.getByText("Could not search this chat. Check the host connection and retry.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    gate.restore();
    await expectReconnectingToastGone(page);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expectHighlight(page, "hello world");
  } finally {
    await agent.cleanup();
  }
});

interface StreamedReplyChat extends MockAgentWorkspace {
  /** Resolves once the streamed reply has finished arriving. */
  replyFinished(): Promise<void>;
}

/**
 * Opens the chat first, then streams a multi-block reply into it and waits for a
 * later block, so the block holding the early needles is no longer the growing row.
 */
async function openChatStreamingMultiBlockReply(page: Page): Promise<StreamedReplyChat> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-live-blocks-",
    title: "Chat Find live blocks",
    featureValues: {
      mockStreamingAssistantResponse: STREAMED_RESPONSE,
      mockStreamingAssistantIntervalMs: 60,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Stream a multi block answer");
    await expect(page.getByText("beta-needle", { exact: false }).last()).toBeVisible({
      timeout: 30_000,
    });
    return {
      ...agent,
      replyFinished: async () => {
        await agent.client.waitForFinish(agent.agentId, 60_000);
      },
    };
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
}

test("finds a hit in a message that streamed while the chat was open", async ({ page }) => {
  test.setTimeout(120_000);
  const chat = await openChatStreamingMultiBlockReply(page);
  try {
    await openChatFind(page);
    // The only hit is in the first paragraph, which is no longer the row that grows.
    await expectFindStatus(page, "alpha-needle", "1 of 1");
    await chat.replyFinished();
    await expectFindStatus(page, "beta-needle", "1 of 1");
    // One message, two Markdown blocks, one count across both.
    await expectFindStatus(page, "pair-needle", "1 of 2");
    await expectNextMatch(page, "2 of 2", "pair-needle");
    await closeFind(page);
  } finally {
    await chat.cleanup();
  }
});

/**
 * Opens a chat whose newest reply is a single message far taller than the viewport,
 * behind enough older turns that the oldest one is not hydrated yet.
 */
async function openChatWithVirtualizedTallMessage(page: Page): Promise<MockAgentWorkspace> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-virtualized-",
    title: "Chat Find virtualized message",
    featureValues: { mockAssistantResponse: TALL_RESPONSE },
  });
  try {
    for (let index = 0; index < 6; index++) {
      await agent.client.sendAgentMessage(agent.agentId, `Prompt number ${index}`);
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    await openAgentRoute(page, agent);
    await expect(page.getByText("Prompt number 5", { exact: true })).toBeVisible();
    await expect(page.getByText("Prompt number 0", { exact: true })).toHaveCount(0);
    return agent;
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
}

// Every block row of the selected message must be mounted for Find to see it, whatever
// the virtualizer's scroll window holds. Otherwise a hit in a far paragraph is missing
// from the count and Next walks off to the next message instead.
test("counts every occurrence of a virtualized message and steps between them", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const chat = await openChatWithVirtualizedTallMessage(page);
  try {
    await openChatFind(page);
    await expectFindStatus(page, "span-needle", "1 of 12");
    await expectHighlight(page, "span-needle");
    await expectNextMatch(page, "2 of 12", "span-needle");
    await closeFind(page);
  } finally {
    await chat.cleanup();
  }
});

test("finds text beyond the normal render cap and restores the cap when Find closes", async ({
  page,
}) => {
  const tail = "oversized-tail-needle";
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-cap-",
    title: "Chat Find long message",
    initialPrompt: "Render a long response",
    // One paragraph, so the needle is past the render cap of the row that holds it.
    featureValues: { mockAssistantResponse: `${"background ".repeat(3100)}${tail}` },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    const message = page.getByTestId("assistant-message");
    await expect(message).toBeVisible();
    await expect(message).not.toContainText(tail);
    await searchChat(page, tail);
    await expectHighlight(page, tail);
    await closeFind(page);
    await expect(message).not.toContainText(tail);
    await expect(message.getByTestId("assistant-message-capped-notice")).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

async function findFromComposer(page: Page, shortcut: string, testInfo: TestInfo) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-composer-",
    title: "Chat Find from composer",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    await searchFromComposerWithoutLosingDraft(page, shortcut);
    await refocusFindAndReplaceQuery(page, shortcut);
    await page.screenshot({ path: testInfo.outputPath("find-from-composer.png") });
    await closeFind(page);
    await expectCommandCenterOwnsFindShortcut(page, shortcut);
    await fillComposerDraft(page, "Draft after closing Find");
    await expectComposerDraft(page, "Draft after closing Find");
  } finally {
    await agent.cleanup();
  }
}

test("opens and refocuses Find with Control+f from the composer", async ({ page }, testInfo) => {
  await findFromComposer(page, "Control+f", testInfo);
});

test.describe("macOS", () => {
  test.use({ userAgent: MAC_USER_AGENT });

  test("opens and refocuses Find with Meta+f from the composer", async ({ page }, testInfo) => {
    await findFromComposer(page, "Meta+f", testInfo);
  });

  // Control+F moves the caret forward on macOS, so chat Find must leave it alone.
  test("leaves Control+f to the composer", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "chat-find-mac-control-f-",
      title: "Chat Find macOS Control+f",
      initialPrompt: "Render the response",
      featureValues: { mockAssistantResponse: RESPONSE },
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 15_000);
      await openAgentRoute(page, agent);
      await fillComposerDraft(page, "Keep this draft");
      await expectComposerFocused(page);
      await recordComposerKeydown(page);
      await page.keyboard.press("Control+f");
      await expect
        .poll(() => recordedComposerFindKeydown(page))
        .toEqual([{ key: "f", defaultPrevented: false }]);
      await expect(query(page)).toHaveCount(0);
      await expectComposerFocused(page);
      await expectComposerDraft(page, "Keep this draft");
    } finally {
      await agent.cleanup();
    }
  });
});

interface RecordedKeydown {
  key: string;
  defaultPrevented: boolean;
}

/**
 * Chat Find listens on `document` in the capture phase, so the composer only ever
 * sees a Find keystroke after Find decided about it. That makes `defaultPrevented`
 * on the composer the evidence of who owns the key.
 */
async function recordComposerKeydown(page: Page) {
  await composerLocator(page).evaluate((element) => {
    const store = window as unknown as { __findKeydown: RecordedKeydown[] };
    store.__findKeydown = [];
    element.addEventListener("keydown", (event) => {
      store.__findKeydown.push({
        key: (event as KeyboardEvent).key,
        defaultPrevented: event.defaultPrevented,
      });
    });
  });
}

async function recordedComposerFindKeydown(page: Page): Promise<RecordedKeydown[]> {
  const recorded = await page.evaluate(
    () => (window as unknown as { __findKeydown: RecordedKeydown[] }).__findKeydown,
  );
  return recorded.filter((entry) => entry.key.toLowerCase() === "f");
}

async function openFindFromComposer(page: Page, shortcut: string) {
  await page.keyboard.press(shortcut);
  await expect(query(page)).toBeFocused();
}

async function searchFromComposerWithoutLosingDraft(page: Page, shortcut: string) {
  await fillComposerDraft(page, "Keep this draft");
  await expectComposerFocused(page);
  await openFindFromComposer(page, shortcut);
  await expectComposerDraft(page, "Keep this draft");
  await query(page).fill("hello world");
  await expectHighlight(page, "hello world");
}

async function refocusFindAndReplaceQuery(page: Page, shortcut: string) {
  await composerLocator(page).click();
  await expectComposerFocused(page);
  await openFindFromComposer(page, shortcut);
  await expect(query(page)).toHaveValue("hello world");
  await expectComposerDraft(page, "Keep this draft");
  await page.keyboard.type("a.b");
  await expect(query(page)).toHaveValue("a.b");
  await expectHighlight(page, "a.b");
}

async function expectCommandCenterOwnsFindShortcut(page: Page, shortcut: string) {
  await openCommandCenter(page);
  await page.keyboard.press(shortcut);
  await expect(page.getByTestId("command-center-panel")).toBeVisible();
  await expect(query(page)).toHaveCount(0);
  await closeCommandCenter(page);
}
