import { expect, type Locator, type TestInfo, type Page } from "@playwright/test";
import { buildAgentRoute, seedMockAgentWorkspace, type MockAgentWorkspace } from "./mock-agent";
import { readReplicaCache } from "./replica-cache-storage";
import {
  delayAgentBootstrapTailResponse,
  delayAgentOlderTimelineResponse,
  holdDaemonHydration,
  holdAgentOlderTimelinePages,
  type AgentTimelineResponseGate,
  type BootstrapTimelineGate,
  type OlderTimelinePagesGate,
  type OlderTimelinePagesOptions,
} from "./agent-timeline-gate";

export { holdDaemonHydration };

interface LongTimelineAgentOptions {
  turns: number;
  /** Live turns stream for ten seconds unless a test needs one that outlasts it. */
  liveTurns?: "ten-second-stream" | "thirty-minute-stream";
}

export interface LongTimelineAgent extends MockAgentWorkspace {
  /** Every seeded prompt, oldest first, so a test can name the nth turn. */
  prompts: string[];
  firstOlderPagePrompt: string;
  initialTailAnchorPrompt: string;
  initialTailOldestPrompt: string;
  /** The newest prompt on the first older page, adjacent to the initial tail. */
  newestOlderPagePrompt: string;
  oldestPrompt: string;
  newestPrompt: string;
}

interface RealisticOlderTimelineAgent extends MockAgentWorkspace {
  newestPrompt: string;
}

export interface ItemPagedToolGroupAgent extends MockAgentWorkspace {
  newestPrompt: string;
  /** Commands in one run, more than an item page holds. */
  totalCommands: number;
  /** Commands of that run the initial tail loads, so the size of the group as first shown. */
  loadedCommands: number;
}

interface ToolCallGroupPositionSnapshot {
  top: number;
}

const ITEM_PAGE_SIZE = 40;
const PROMPT_PREFIX = "timeline-pagination-turn";
const LIVE_BEFORE_HYDRATION_PROMPT = "timeline live before authoritative hydration";
const HISTORY_START_THRESHOLD_PX = 96;

interface TimelineViewportSnapshot {
  scrollHeight: number;
  scrollTop: number;
}

export interface TimelinePresentationSnapshot {
  marker: string;
  position: TimelinePromptPositionSnapshot;
  viewport: TimelineViewportSnapshot;
}

interface TimelinePromptPositionSnapshot {
  prompt: string;
  top: number;
}

interface OlderHistoryPages {
  expectRequestedPages(count: number): Promise<void>;
  expectSettledWithRequestedPages(count: number): Promise<void>;
  expectNoRepeatedEntries(): void;
  expectRepeatedEntries(): void;
  expectOwnedTextRendered(text: string): Promise<void>;
  releasePage(pageNumber: number): void;
  requestCount(): number;
}

function promptForTurn(index: number): string {
  return `${PROMPT_PREFIX}-${index}: emit 1 coalesced agent stream updates`;
}

export async function seedLongMockAgentTimeline(
  options: LongTimelineAgentOptions,
): Promise<LongTimelineAgent> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "timeline-pagination-",
    title: "Timeline pagination regression",
    model: options.liveTurns ?? "ten-second-stream",
  });

  for (let index = 0; index < options.turns; index += 1) {
    await agent.client.sendAgentMessage(agent.agentId, promptForTurn(index));
    await agent.client.waitForFinish(agent.agentId, 15_000);
  }

  return {
    ...agent,
    prompts: Array.from({ length: options.turns }, (_unused, index) => promptForTurn(index)),
    firstOlderPagePrompt: promptForTurn(Math.max(0, options.turns - 40)),
    initialTailAnchorPrompt: promptForTurn(Math.max(0, options.turns - 5)),
    initialTailOldestPrompt: promptForTurn(Math.max(0, options.turns - 20)),
    newestOlderPagePrompt: promptForTurn(Math.max(0, options.turns - 21)),
    oldestPrompt: promptForTurn(0),
    newestPrompt: promptForTurn(options.turns - 1),
  };
}

export async function seedRealisticOlderTimeline(): Promise<RealisticOlderTimelineAgent> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "timeline-realistic-older-history-",
    title: "Realistic older timeline pagination regression",
    model: "ten-second-stream",
  });

  const olderTurnCount = 40;
  for (let index = 0; index < olderTurnCount; index += 1) {
    await agent.client.sendAgentMessage(
      agent.agentId,
      `timeline-pagination-older-turn-${index}: emit 1 coalesced agent stream updates`,
    );
    await agent.client.waitForFinish(agent.agentId, 15_000);
  }

  await agent.client.sendAgentMessage(agent.agentId, "build a realistic long mock timeline");
  await agent.client.waitForFinish(agent.agentId, 20_000);

  const newerTurnCount = 20;
  for (let index = 0; index < newerTurnCount; index += 1) {
    await agent.client.sendAgentMessage(agent.agentId, promptForTurn(index));
    await agent.client.waitForFinish(agent.agentId, 15_000);
  }

  return {
    ...agent,
    newestPrompt: promptForTurn(newerTurnCount - 1),
  };
}

/**
 * A run of commands longer than an item page, followed by enough short turns that the
 * initial tail ends inside the run. Read with item pages, the tail loads the newest
 * commands as one group; the older page carries the rest of that run and the turns before
 * it, with a further page behind it.
 */
export async function seedItemPagedToolGroupTimeline(): Promise<ItemPagedToolGroupAgent> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "timeline-item-page-tool-group-",
    title: "Item page tool group regression",
  });
  const olderTurns = 10;
  const newerTurns = 12;
  const totalCommands = 50;
  // A short turn is its prompt and one reply; the run's turn ends with one reply.
  const loadedCommands = ITEM_PAGE_SIZE - newerTurns * 2 - 1;
  const shortTurnPrompt = (label: string, index: number) =>
    `item-page-${label}-turn-${index}: emit 1 coalesced agent stream updates`;
  const sendTurn = async (prompt: string) => {
    await agent.client.sendAgentMessage(agent.agentId, prompt);
    await agent.client.waitForFinish(agent.agentId, 15_000);
  };

  for (let index = 0; index < olderTurns; index += 1) {
    await sendTurn(shortTurnPrompt("older", index));
  }
  await sendTurn(`emit ${totalCommands} tool agent stream updates`);
  for (let index = 0; index < newerTurns; index += 1) {
    await sendTurn(shortTurnPrompt("newer", index));
  }

  return {
    ...agent,
    newestPrompt: shortTurnPrompt("newer", newerTurns - 1),
    totalCommands,
    loadedCommands,
  };
}

export async function useChatDisplay(
  page: Page,
  chatDisplay: "full" | "collapseToolCalls" | "collapseTurns",
): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ chatDisplay: value }));
  }, chatDisplay);
}

function toolCallGroup(page: Page, commandCount: number): Locator {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  return timeline
    .getByTestId("tool-call-group")
    .getByRole("button", { name: `Ran ${commandCount} commands`, exact: true });
}

export async function rememberToolCallGroupPosition(
  page: Page,
  commandCount: number,
): Promise<ToolCallGroupPositionSnapshot> {
  const group = toolCallGroup(page, commandCount);
  await expect(group).toBeVisible();
  const box = await group.boundingBox();
  if (!box) {
    throw new Error(`Expected a rendered tool-call group of ${commandCount} commands`);
  }
  return { top: box.y };
}

/** The group the reader was on keeps its place on screen, now counting the older page's calls. */
export async function expectToolCallGroupPositionPreserved(
  page: Page,
  commandCount: number,
  before: ToolCallGroupPositionSnapshot,
): Promise<void> {
  const group = toolCallGroup(page, commandCount);
  await expect(group).toBeVisible();
  await expect
    .poll(
      async () => {
        const box = await group.boundingBox();
        return box ? Math.abs(box.y - before.top) : Number.POSITIVE_INFINITY;
      },
      { message: `the group of ${commandCount} commands keeps its viewport position` },
    )
    .toBeLessThanOrEqual(2);
}

export async function scrollThroughOlderHistoryPages(
  page: Page,
  pageCount: number,
  history: OlderHistoryPages,
): Promise<void> {
  for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
    await userScrollsTimelineToHistoryStart(page);
    await history.expectRequestedPages(pageNumber + 1);
    history.releasePage(pageNumber + 1);
    await history.expectSettledWithRequestedPages(pageNumber + 1);
  }
}

export async function rememberTimelinePromptPosition(
  page: Page,
  prompt: string,
): Promise<TimelinePromptPositionSnapshot> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const item = timeline.getByText(prompt, { exact: true });
  await expect(item).toBeVisible();
  const box = await item.boundingBox();
  if (!box) {
    throw new Error(`Expected a rendered timeline item for ${prompt}`);
  }
  return { prompt, top: box.y };
}

export async function expectTimelinePromptLandedBelowTop(
  page: Page,
  prompt: string,
): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const promptRow = timeline.locator("[data-history-row-id]").filter({ hasText: prompt });
  await expect(promptRow).toBeVisible();
  await expect
    .poll(async () => {
      const [timelineBox, promptBox] = await Promise.all([
        timeline.boundingBox(),
        promptRow.boundingBox(),
      ]);
      if (!timelineBox || !promptBox) return Number.POSITIVE_INFINITY;
      return Math.abs(promptBox.y - timelineBox.y - 8);
    })
    .toBeLessThanOrEqual(2);
}

export async function expectTimelinePromptPositionPreserved(
  page: Page,
  before: TimelinePromptPositionSnapshot,
): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const item = timeline.getByText(before.prompt, { exact: true });
  await expect(item).toBeVisible();
  await expect
    .poll(async () => {
      const box = await item.boundingBox();
      return box ? Math.abs(box.y - before.top) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(2);
}

export async function expectTimelineAtMaximumScrollWithPromptVisible(
  page: Page,
  prompt: string,
): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const item = timeline.getByText(prompt, { exact: true });
  await expect
    .poll(async () => {
      const [metrics, timelineBox, promptBox] = await Promise.all([
        timeline.evaluate((element) => {
          if (!(element instanceof HTMLElement)) {
            throw new Error("Agent chat scroll element is not an HTMLElement");
          }
          return {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
          };
        }),
        timeline.boundingBox(),
        item.boundingBox(),
      ]);
      if (!timelineBox || !promptBox) return false;
      const isAtMaximumScroll =
        Math.abs(metrics.scrollTop + metrics.clientHeight - metrics.scrollHeight) <= 2;
      const isPromptFullyVisible =
        promptBox.y >= timelineBox.y &&
        promptBox.y + promptBox.height <= timelineBox.y + timelineBox.height;
      return isAtMaximumScroll && isPromptFullyVisible;
    })
    .toBe(true);
}

export async function openAgentTimeline(
  page: Page,
  agent: MockAgentWorkspace,
  serverId?: string,
): Promise<void> {
  await page.goto(buildAgentRoute(agent.workspaceId, agent.agentId, serverId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
}

export async function expectTimelinePromptVisible(page: Page, prompt: string): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await expect(timeline.getByText(prompt, { exact: true })).toBeVisible({ timeout: 30_000 });
}

export async function expectTimelinePromptCentered(page: Page, prompt: string): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const message = timeline.getByTestId("user-message").filter({ hasText: prompt });
  await expect(message).toBeVisible();
  await expect
    .poll(async () => {
      const [timelineBox, messageBox] = await Promise.all([
        timeline.boundingBox(),
        message.boundingBox(),
      ]);
      if (!timelineBox || !messageBox) {
        return Number.POSITIVE_INFINITY;
      }
      const timelineCenter = timelineBox.x + timelineBox.width / 2;
      const messageCenter = messageBox.x + messageBox.width / 2;
      return Math.abs(timelineCenter - messageCenter);
    })
    .toBeLessThanOrEqual(2);
}

export async function expectTimelinePromptNotMounted(page: Page, prompt: string): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await expect(timeline.getByText(prompt, { exact: true })).toHaveCount(0);
}

export async function makeLoadedTimelineFitViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 20_000 });
}

export async function expectLoadedTimelineDoesNotScroll(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await expect
    .poll(async () =>
      scroll.evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          throw new Error("Agent chat scroll element is not an HTMLElement");
        }
        return element.scrollHeight <= element.clientHeight;
      }),
    )
    .toBe(true);
}

export async function reloadAgentTimelineFromPersistedReplica(
  page: Page,
  agent: LongTimelineAgent,
): Promise<void> {
  await expect
    .poll(async () => {
      const cache = await readReplicaCache(page);
      const timeline = cache?.hosts
        ?.flatMap((host) => host.timelines)
        .find((candidate) => candidate.agentId === agent.agentId);
      return timeline?.items?.length === 50;
    })
    .toBe(true);

  await page.reload();
  await expectTimelinePromptVisible(page, agent.newestPrompt);
}

export async function holdNextOlderTimelinePage(
  page: Page,
  agent: LongTimelineAgent,
): Promise<AgentTimelineResponseGate & { expectLoading(): Promise<void> }> {
  const gate = await delayAgentOlderTimelineResponse(page, agent.agentId);
  return {
    ...gate,
    async expectLoading() {
      await gate.waitForDelayedResponse();
      await expect(page.getByTestId("load-older-history-spinner")).toBeVisible();
      await expectTimelinePromptNotMounted(page, agent.oldestPrompt);
    },
  };
}

export async function holdOlderHistoryPages(
  page: Page,
  agent: MockAgentWorkspace,
  options?: OlderTimelinePagesOptions,
): Promise<OlderHistoryPages> {
  const gate: OlderTimelinePagesGate = await holdAgentOlderTimelinePages(
    page,
    agent.agentId,
    options,
  );
  const loader = page.getByTestId("load-older-history-spinner");
  return {
    async expectRequestedPages(count) {
      await gate.waitForRequestCount(count);
      expect(gate.getRequestCount()).toBe(count);
    },
    async expectSettledWithRequestedPages(count) {
      await waitForTimelineGeometryToSettle(page);
      // The loader stays until the prepend settles and the viewport decides whether to
      // keep loading. Once it hides, no further page loads without new user intent.
      await expect
        .poll(
          async () => ({
            requestedPages: gate.getRequestCount(),
            loading: await loader.isVisible(),
          }),
          { message: `older history settles after ${count} requested page(s)` },
        )
        .toEqual({ requestedPages: count, loading: false });
    },
    expectNoRepeatedEntries() {
      expect(gate.getRepeatedEntryCount()).toBe(0);
    },
    expectRepeatedEntries() {
      expect(gate.getRepeatedEntryCount()).toBeGreaterThan(0);
    },
    async expectOwnedTextRendered(text) {
      const expectedCount = gate.getOwnedEntryCountContaining(text);
      expect(expectedCount).toBeGreaterThan(0);
      const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
      await expect(timeline.getByText(text, { exact: false })).toHaveCount(expectedCount);
    },
    releasePage(pageNumber) {
      gate.releasePage(pageNumber);
    },
    requestCount() {
      return gate.getRequestCount();
    },
  };
}

export async function rememberTimelineViewport(page: Page): Promise<TimelineViewportSnapshot> {
  return readTimelineViewport(page);
}

export async function expectStableHistoryStartGutter(page: Page): Promise<void> {
  const gutter = page.getByTestId("older-history-slot");
  await expect(gutter).toBeAttached();
  await expect
    .poll(() => gutter.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(32);
}

export async function scrollTimelinePromptIntoView(page: Page, prompt: string): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const row = timeline.getByTestId("user-message").filter({ hasText: prompt });
  const [viewport, target] = await Promise.all([timeline.boundingBox(), row.boundingBox()]);
  if (!viewport || !target) {
    throw new Error(`Expected a rendered timeline prompt for ${prompt}`);
  }
  // Programmatic scrolling does not express the user's intent to stop following output.
  await timeline.hover();
  await page.mouse.wheel(0, target.y - viewport.y - (viewport.height - target.height) / 2);
  await expect(row).toBeInViewport({ ratio: 1 });
  await waitForTimelineGeometryToSettle(page);
  await expect
    .poll(async () => (await readTimelineViewport(page)).scrollTop)
    .toBeGreaterThan(HISTORY_START_THRESHOLD_PX);
}

export async function rememberTimelinePresentation(
  page: Page,
  prompt: string,
): Promise<TimelinePresentationSnapshot> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const row = timeline.getByTestId("user-message").filter({ hasText: prompt });
  await expect(row).toBeVisible();
  const marker = `timeline-presentation-${Date.now()}`;
  await row.evaluate((element, value) => {
    element.dataset.timelinePresentation = value;
  }, marker);
  return {
    marker,
    position: await rememberTimelinePromptPosition(page, prompt),
    viewport: await rememberTimelineViewport(page),
  };
}

export async function expectTimelinePresentationUnchanged(
  page: Page,
  before: TimelinePresentationSnapshot,
): Promise<void> {
  await expect(page.locator(`[data-timeline-presentation="${before.marker}"]`)).toBeVisible();
  await expectTimelinePromptPositionPreserved(page, before.position);
  await expect.poll(async () => rememberTimelineViewport(page)).toEqual(before.viewport);
}

export async function expectTimelineViewportAnchoredAfterPrepend(
  page: Page,
  before: TimelineViewportSnapshot,
): Promise<void> {
  await expect
    .poll(async () => (await readTimelineViewport(page)).scrollHeight)
    .toBeGreaterThan(before.scrollHeight);
  await waitForTimelineGeometryToSettle(page);
  const after = await readTimelineViewport(page);
  const contentGrowth = after.scrollHeight - before.scrollHeight;
  const scrollAdjustment = after.scrollTop - before.scrollTop;
  expect(Math.abs(contentGrowth - scrollAdjustment)).toBeLessThanOrEqual(2);
}

/**
 * Item-based pages from older hosts split turns, so the oldest loaded turn starts
 * mid-turn: its prompt is above loaded history. Returns that prompt.
 */
export async function expectOldestLoadedTurnPartial(
  page: Page,
  prompts: readonly string[],
): Promise<string> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const oldestLoadedPrompt = await timeline
    .getByTestId("user-message")
    .first()
    .evaluate((element) => element.textContent ?? "");
  const loadedIndex = prompts.findIndex((prompt) => oldestLoadedPrompt.includes(prompt));
  expect(loadedIndex, "oldest loaded prompt is a seeded turn").toBeGreaterThan(0);
  const oldestRow = timeline.locator("[data-history-row-id]").first();
  await expect(oldestRow.getByTestId("user-message"), "rows above the oldest prompt").toHaveCount(
    0,
  );
  const partialPrompt = prompts[loadedIndex - 1]!;
  await expectTimelinePromptNotMounted(page, partialPrompt);
  return partialPrompt;
}

/** The reader stays with the turn they were reading once it folds behind its summary. */
export async function expectFoldedTurnAtReadingPosition(page: Page, prompt: string): Promise<void> {
  const timeline = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const promptRow = timeline.locator("[data-history-row-id]").filter({ hasText: prompt });
  await expect(promptRow).toBeVisible({ timeout: 15_000 });
  // The host row carries the folded turn's summary line.
  await expect(promptRow.getByTestId("turn-summary")).toBeVisible();
  await expect
    .poll(
      async () => {
        const [timelineBox, promptBox] = await Promise.all([
          timeline.boundingBox(),
          promptRow.boundingBox(),
        ]);
        if (!timelineBox || !promptBox) return false;
        const offset = promptBox.y - timelineBox.y;
        return offset >= 0 && offset <= timelineBox.height / 2;
      },
      { message: "folded turn sits in the upper half of the viewport" },
    )
    .toBe(true);
}

export async function expectTimelineAtHistoryStart(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readTimelineViewport(page)).scrollTop)
    .toBeLessThanOrEqual(HISTORY_START_THRESHOLD_PX);
}

export async function holdBootstrapTimelinePage(
  page: Page,
  agent: LongTimelineAgent,
): Promise<BootstrapTimelineGate> {
  return delayAgentBootstrapTailResponse(page, agent.agentId);
}

export async function sendLiveTurnBeforeHydration(agent: LongTimelineAgent): Promise<string> {
  await agent.client.sendAgentMessage(agent.agentId, LIVE_BEFORE_HYDRATION_PROMPT);
  await agent.client.waitForFinish(agent.agentId, 15_000);
  return LIVE_BEFORE_HYDRATION_PROMPT;
}

export async function scrollTimelineToOldestLoadedEdge(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await scroll.hover();
  await page.mouse.wheel(0, -20_000);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await scroll.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Agent chat scroll element is not an HTMLElement");
    }
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

export async function userScrollsTimelineToHistoryStart(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await scroll.hover();
  await returnTimelineToSettledHistoryStart(page, () => page.mouse.wheel(0, -1_000));
}

export async function userNavigatesTimelineToHistoryStartWithKeyboard(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await scroll.focus();
  await returnTimelineToSettledHistoryStart(page, () => page.keyboard.press("Home"));
}

async function returnTimelineToSettledHistoryStart(
  page: Page,
  moveUp: () => Promise<unknown>,
): Promise<void> {
  const loadingSpinner = page.getByTestId("load-older-history-spinner");
  // A caller may only start a new history traversal after its prior page has settled.
  await expect(loadingSpinner).toBeHidden();
  let previous = await readTimelineViewport(page);
  while (true) {
    await moveUp();
    await waitForTimelineGeometryToSettle(page);
    let viewport = await readTimelineViewport(page);
    // Tests that hold the response need to observe the requested page before releasing it.
    if (await loadingSpinner.isVisible()) {
      return;
    }
    if (viewport.scrollTop <= HISTORY_START_THRESHOLD_PX) {
      return;
    }
    await expect(loadingSpinner).toBeHidden();
    await waitForTimelineGeometryToSettle(page);
    viewport = await readTimelineViewport(page);
    expect(
      viewport.scrollTop < previous.scrollTop || viewport.scrollHeight > previous.scrollHeight,
    ).toBe(true);
    previous = viewport;
  }
}

export async function scrollTimelineToNewestLoadedEdge(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await scroll.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Agent chat scroll element is not an HTMLElement");
    }
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

export async function scrollTimelineUntilOlderHistoryIsReachable(
  page: Page,
  oldestPrompt: string,
): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  const prompt = scroll.getByText(oldestPrompt, { exact: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await prompt.count()) > 0) {
      await expect(prompt).toBeVisible();
      return;
    }
    const previousHeight = await readTimelineViewport(page);
    await userScrollsTimelineToHistoryStart(page);
    await expect
      .poll(async () => (await readTimelineViewport(page)).scrollHeight)
      .toBeGreaterThan(previousHeight.scrollHeight);
    await waitForTimelineGeometryToSettle(page);
  }
  await expect(prompt).toBeVisible();
}

async function readTimelineViewport(page: Page): Promise<TimelineViewportSnapshot> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  return scroll.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Agent chat scroll element is not an HTMLElement");
    }
    return { scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
  });
}

export async function waitForTimelineGeometryToSettle(page: Page): Promise<void> {
  const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
  await scroll.evaluate(
    (element) =>
      new Promise<void>((resolve, reject) => {
        if (!(element instanceof HTMLElement)) {
          reject(new Error("Agent chat scroll element is not an HTMLElement"));
          return;
        }
        const startedAt = performance.now();
        let stableFrames = 0;
        let previous = `${element.scrollTop}:${element.scrollHeight}`;
        const sample = () => {
          const current = `${element.scrollTop}:${element.scrollHeight}`;
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 4) {
            resolve();
            return;
          }
          if (performance.now() - startedAt > 5_000) {
            reject(new Error("Timeline geometry did not settle"));
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
}

function spokenTimelinePrompt(text: string): string {
  return `<spoken-input>\n${text}\n</spoken-input>\n<instruction>This message was spoken by the user. Respond using the speak tool only, not normal messages, because the user may not be looking at the chat.</instruction>`;
}

export async function expectSpokenTimelinePrompt(page: Page, text: string): Promise<void> {
  await expectTimelinePromptVisible(page, text);
  const row = page.getByTestId("user-message").filter({ hasText: text });
  await expect(row).not.toContainText("<spoken-input>");
  await expect(row).not.toContainText("<instruction>");
  await expect(row).not.toContainText("This message was spoken by the user.");
}

export async function sendSpokenTimelinePrompt(
  agent: MockAgentWorkspace,
  text: string,
): Promise<void> {
  await agent.client.sendAgentMessage(agent.agentId, spokenTimelinePrompt(text));
  await agent.client.waitForFinish(agent.agentId, 15_000);
}

export async function withSpokenTimeline(
  historyText: string,
  run: (agent: MockAgentWorkspace) => Promise<void>,
): Promise<void> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "spoken-timeline-",
    title: "Spoken timeline presentation",
    initialPrompt: spokenTimelinePrompt(historyText),
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await run(agent);
  } finally {
    await agent.cleanup();
  }
}

export async function reloadSpokenTimeline(page: Page): Promise<void> {
  await page.reload();
}

export async function captureSpokenTimeline(
  page: Page,
  testInfo: TestInfo,
  size: "desktop" | "compact",
): Promise<void> {
  await page.setViewportSize(
    size === "compact" ? { width: 390, height: 844 } : { width: 1280, height: 900 },
  );
  await testInfo.attach(`spoken-${size}-web`, {
    body: await page.screenshot({ path: testInfo.outputPath(`spoken-${size}-web.png`) }),
    contentType: "image/png",
  });
}
