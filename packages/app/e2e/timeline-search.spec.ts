import { test, expect, type Page } from "./fixtures";
import { awaitToolCall, expectAgentIdle } from "./helpers/agent-stream";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";

const OUTPUT_QUERY = "userIsAtBottom";
// The deterministic mock stream's large-file payload repeats a line starting
// "file xxxx...96-more-x's". "file xxxx" is distinctive enough (unlike the
// bare word "file") to avoid colliding with unrelated UI text while still
// matching once per repeated line.
const LARGE_ITEM_QUERY = "file xxxx";
const ACTIVE_MATCH_BACKGROUND = "rgb(217, 119, 6)";

interface MatchSpan {
  backgroundColor: string;
  color: string;
  top: number;
  bottom: number;
}

function findMatchSpans(query: string): MatchSpan[] {
  // Scope to the chat timeline: the find panel also renders each result's
  // snippet with the matched substring in its own highlighted <span>, so a
  // document-wide query would double-count every match (one panel row + one
  // timeline occurrence). These assertions are about the rendered TIMELINE
  // matches only.
  const root = document.querySelector('[data-testid="agent-chat-scroll"]') ?? document;
  return Array.from(root.querySelectorAll("span"))
    .filter((element) => element.textContent === query)
    .map((element) => {
      const { backgroundColor, color } = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { backgroundColor, color, top: rect.top, bottom: rect.bottom };
    });
}

async function openTimelineSearch(page: Page): Promise<void> {
  // Direct navigation restores the agent tab but does not make its pane the
  // focused pane. Ctrl+F is routed through that focus state, so activate the
  // chat pane exactly as a user would before sending the shortcut.
  await page.getByTestId("agent-chat-scroll").click();
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("timeline-search-panel")).toBeVisible();
}

/**
 * Asserts exactly one rendered match for `query` carries the active (amber)
 * highlight, and that it sits below the find panel and within the chat
 * scroll viewport — i.e. it was actually scrolled into view, not left
 * hidden behind the panel or off the bottom of the visible area. Returns
 * the full set of rendered match spans for further assertions (e.g.
 * distinct active/inactive styling, or diffing across a navigation step).
 */
async function expectActiveMatchRevealedBelowPanel(
  page: Page,
  query: string,
): Promise<MatchSpan[]> {
  const panel = page.getByTestId("timeline-search-panel");
  const chat = page.getByTestId("agent-chat-scroll").first();
  const selection = await page.evaluate(findMatchSpans, query);
  const panelBox = await panel.boundingBox();
  const chatBox = await chat.boundingBox();
  const active = selection.find((match) => match.backgroundColor === ACTIVE_MATCH_BACKGROUND);
  expect(panelBox).not.toBeNull();
  expect(chatBox).not.toBeNull();
  expect(active, "expected exactly one actively-highlighted match").toBeDefined();
  expect(active?.top).toBeGreaterThanOrEqual(panelBox!.y + panelBox!.height);
  expect(active?.bottom).toBeLessThanOrEqual(chatBox!.y + chatBox!.height);
  return selection;
}

test.describe("Timeline search", () => {
  test("filters tool output, distinguishes the active match, and reveals it below the find panel", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "timeline-search-e2e-",
      title: "Timeline search regression",
      model: "ten-second-stream",
      initialPrompt: "Emit the deterministic mock tool sequence for timeline search.",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
      await expectAgentIdle(page);
      await awaitToolCall(page, "bash");

      await openTimelineSearch(page);
      const panel = page.getByTestId("timeline-search-panel");
      const input = page.getByTestId("timeline-search-input");
      await expect(panel).toBeVisible();
      await input.fill(OUTPUT_QUERY);
      await page.getByTestId("timeline-search-filter-toolOutput").click();
      await expect(page.getByText("2 matches", { exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(findMatchSpans, OUTPUT_QUERY)).toHaveLength(2);

      const firstSelection = await expectActiveMatchRevealedBelowPanel(page, OUTPUT_QUERY);
      expect(new Set(firstSelection.map((match) => match.backgroundColor)).size).toBe(2);

      await page.getByTestId("timeline-search-next").click();
      await expect
        .poll(() => page.evaluate(findMatchSpans, OUTPUT_QUERY))
        .not.toEqual(firstSelection);

      // Regression coverage for 905c770e5 ("reveal tool results and restore
      // highlights"): stepping to a SECOND occurrence within the SAME tool
      // item previously skipped the coarse row scroll (it was keyed only to
      // the item id, not the occurrence), so the newly active match could
      // land hidden behind the find panel. Re-run the same reveal assertion
      // for the new selection, not just a "the highlight moved" check.
      const secondSelection = await expectActiveMatchRevealedBelowPanel(page, OUTPUT_QUERY);
      expect(new Set(secondSelection.map((match) => match.backgroundColor)).size).toBe(2);
    } finally {
      await agent.cleanup();
    }
  });

  test("reveals the active match inside a large, internally-scrolled tool result", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "timeline-search-large-e2e-",
      title: "Timeline search large tool result",
      model: "ten-second-stream",
      // Triggers the mock provider's special-case large-payload turn: a
      // single completed "read" tool call whose content is ~6KB of repeated
      // "file xxxx...x" lines (see mock-load-test-agent.ts). Inline tool
      // detail views clip to a 300px-tall internal ScrollView by default, so
      // an occurrence deep in this content requires
      // useRevealActiveToolDetailLine to scroll the INNER ScrollView, not
      // just the outer timeline viewport.
      initialPrompt: "emit 6000 byte large file agent stream update",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
      await expectAgentIdle(page);
      await awaitToolCall(page, "read");

      await openTimelineSearch(page);
      const panel = page.getByTestId("timeline-search-panel");
      const input = page.getByTestId("timeline-search-input");
      await expect(panel).toBeVisible();
      await input.fill(LARGE_ITEM_QUERY);
      await page.getByTestId("timeline-search-filter-toolOutput").click();
      await expect(page.getByText(/^\d+ matches$/)).toBeVisible();
      await expect.poll(() => page.evaluate(findMatchSpans, LARGE_ITEM_QUERY)).not.toHaveLength(0);

      const firstSelection = await expectActiveMatchRevealedBelowPanel(page, LARGE_ITEM_QUERY);

      // "prev" from the first (topmost) match wraps directly to the LAST
      // occurrence — the deepest line in the repeated payload, and the one
      // most likely to be left off-screen by a scroll that only handles the
      // outer viewport.
      await page.getByTestId("timeline-search-prev").click();
      await expect
        .poll(() => page.evaluate(findMatchSpans, LARGE_ITEM_QUERY))
        .not.toEqual(firstSelection);
      await expectActiveMatchRevealedBelowPanel(page, LARGE_ITEM_QUERY);
    } finally {
      await agent.cleanup();
    }
  });

  test("cycles matches forward with Enter and backward with Shift+Enter", async ({ page }) => {
    test.setTimeout(90_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "timeline-search-enter-e2e-",
      title: "Timeline search Enter key nav",
      model: "ten-second-stream",
      initialPrompt: "Emit the deterministic mock tool sequence for timeline search.",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
      await expectAgentIdle(page);
      await awaitToolCall(page, "bash");

      await openTimelineSearch(page);
      const input = page.getByTestId("timeline-search-input");
      await input.fill(OUTPUT_QUERY);
      await page.getByTestId("timeline-search-filter-toolOutput").click();
      await expect(page.getByText("2 matches", { exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(findMatchSpans, OUTPUT_QUERY)).toHaveLength(2);

      const firstSelection = await page.evaluate(findMatchSpans, OUTPUT_QUERY);

      // Plain Enter fires via onSubmitEditing (not onKeyPress — see the
      // panel's handleKeyPress comment) and steps forward.
      await input.press("Enter");
      await expect
        .poll(() => page.evaluate(findMatchSpans, OUTPUT_QUERY))
        .not.toEqual(firstSelection);
      const secondSelection = await page.evaluate(findMatchSpans, OUTPUT_QUERY);

      // Shift+Enter steps backward via onKeyPress, wrapping back to the
      // first match (there are exactly two).
      await input.press("Shift+Enter");
      await expect.poll(() => page.evaluate(findMatchSpans, OUTPUT_QUERY)).toEqual(firstSelection);

      // A second plain Enter moves forward again, off the original match.
      await input.press("Enter");
      await expect.poll(() => page.evaluate(findMatchSpans, OUTPUT_QUERY)).toEqual(secondSelection);
    } finally {
      await agent.cleanup();
    }
  });

  test("scopes results to the active filter", async ({ page }) => {
    test.setTimeout(90_000);
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "timeline-search-filter-e2e-",
      title: "Timeline search filter switching",
      model: "ten-second-stream",
      initialPrompt: "Emit the deterministic mock tool sequence for timeline search.",
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
      await expectAgentIdle(page);
      await awaitToolCall(page, "bash");

      await openTimelineSearch(page);
      const input = page.getByTestId("timeline-search-input");
      await input.fill(OUTPUT_QUERY);

      // "toolOutput" is the only surface containing this bash-output text.
      await page.getByTestId("timeline-search-filter-toolOutput").click();
      await expect(page.getByText("2 matches", { exact: true })).toBeVisible();

      // "prompts" scopes the search to user_message text only — this string
      // never appears in the user's own prompt, so switching filters (not
      // the query) drops the result count to zero.
      await page.getByTestId("timeline-search-filter-prompts").click();
      await expect(page.getByText("No results", { exact: true })).toBeVisible();

      // Switching back to "toolOutput" restores the same two matches.
      await page.getByTestId("timeline-search-filter-toolOutput").click();
      await expect(page.getByText("2 matches", { exact: true })).toBeVisible();
    } finally {
      await agent.cleanup();
    }
  });
});
