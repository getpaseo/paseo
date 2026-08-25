import { expect, type Page } from "@playwright/test";
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
} from "./agent-timeline-gate";

export { holdDaemonHydration };

interface LongTimelineAgentOptions {
  turns: number;
}

export interface LongTimelineAgent extends MockAgentWorkspace {
  /** Every seeded prompt, oldest first, so a test can name the nth turn. */
  prompts: string[];
  firstOlderPagePrompt: string;
  initialTailAnchorPrompt: string;
  initialTailOldestPrompt: string;
  oldestPrompt: string;
  newestPrompt: string;
}

interface RealisticOlderTimelineAgent extends MockAgentWorkspace {
  newestPrompt: string;
}

const PROMPT_PREFIX = "timeline-pagination-turn";
const LIVE_BEFORE_HYDRATION_PROMPT = "timeline live before authoritative hydration";
const HISTORY_START_THRESHOLD_PX = 96;

interface TimelineViewportSnapshot {
  scrollHeight: number;
  scrollTop: number;
}

interface PersistedCanonicalTimelineRange {
  epoch: string;
  startSeq: number;
  endSeq: number;
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

interface OlderHistoryLoadingOperation {
  animationStartTime: number | null;
  marker: string;
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
    model: "ten-second-stream",
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
      const timeline = cache?.hosts?.find(
        (host) => host.timeline?.agentId === agent.agentId,
      )?.timeline;
      return timeline?.items?.length === 50;
    })
    .toBe(true);

  await page.reload();
  await expectTimelinePromptVisible(page, agent.newestPrompt);
}

export async function waitForPersistedCanonicalTimelineRange(
  page: Page,
  agentId: string,
): Promise<PersistedCanonicalTimelineRange> {
  const readRange = async () => {
    const cache = await readReplicaCache(page);
    if (cache?.version !== 6) return null;
    const range = cache.hosts?.find((host) => host.timeline?.agentId === agentId)?.timeline?.range;
    if (
      typeof range?.epoch !== "string" ||
      typeof range.startSeq !== "number" ||
      typeof range.endSeq !== "number"
    ) {
      return null;
    }
    return { epoch: range.epoch, startSeq: range.startSeq, endSeq: range.endSeq };
  };

  await expect.poll(readRange).not.toBeNull();
  const range = await readRange();
  if (!range) {
    throw new Error(`Persisted canonical timeline range is missing for ${agentId}`);
  }
  return range;
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
  daemonPort?: number,
): Promise<OlderHistoryPages> {
  const gate: OlderTimelinePagesGate = await holdAgentOlderTimelinePages(
    page,
    agent.agentId,
    daemonPort,
  );
  return {
    async expectRequestedPages(count) {
      await gate.waitForRequestCount(count);
      expect(gate.getRequestCount()).toBe(count);
    },
    async expectSettledWithRequestedPages(count) {
      await waitForTimelineGeometryToSettle(page);
      expect(gate.getRequestCount()).toBe(count);
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
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
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

export async function rememberOlderHistoryLoadingOperation(
  page: Page,
): Promise<OlderHistoryLoadingOperation> {
  const slot = page.getByTestId("load-older-history-spinner");
  await expect(slot).toBeVisible();
  const marker = `older-history-loading-${Date.now()}`;
  await slot.evaluate((element, operationMarker) => {
    const candidates = [element, ...Array.from(element.querySelectorAll("*"))];
    const animated = candidates.find(
      (candidate) => getComputedStyle(candidate).animationName !== "none",
    );
    if (!(animated instanceof HTMLElement)) {
      throw new Error("Expected the older-history loader to contain an animated element");
    }
    animated.dataset.olderHistoryLoadingOperation = operationMarker;
  }, marker);
  const animated = page.locator(`[data-older-history-loading-operation="${marker}"]`);
  await expect
    .poll(async () => {
      const startTime = await animated.evaluate((element) => element.getAnimations()[0]?.startTime);
      return typeof startTime === "number" ? startTime : null;
    })
    .not.toBeNull();
  const animationStartTime = await animated.evaluate((element) => {
    const startTime = element.getAnimations()[0]?.startTime;
    return typeof startTime === "number" ? startTime : null;
  });
  return { animationStartTime, marker };
}

export async function expectSameOlderHistoryLoadingOperation(
  page: Page,
  operation: OlderHistoryLoadingOperation,
): Promise<void> {
  const animated = page.locator(`[data-older-history-loading-operation="${operation.marker}"]`);
  await expect(animated).toBeVisible();
  const animationStartTime = await animated.evaluate((element) => {
    const startTime = element.getAnimations()[0]?.startTime;
    return typeof startTime === "number" ? startTime : null;
  });
  expect(animationStartTime).toBe(operation.animationStartTime);
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

async function waitForTimelineGeometryToSettle(page: Page): Promise<void> {
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
