import { expect, type Page } from "@playwright/test";
import type { installDaemonWebSocketGate } from "./daemon-websocket-gate";
import { readReplicaCache } from "./replica-cache-storage";
import type { LongTimelineAgent } from "./timeline-pagination";
import {
  expectReconnectingToastGone,
  expectReconnectingToastVisible,
  setTabVisibility,
} from "./workspace-ui";

type DaemonWebSocketGate = Awaited<ReturnType<typeof installDaemonWebSocketGate>>;

const SUBSCRIPTION_REQUEST = "agent.timeline.set_subscription.request";
const SUBSCRIPTION_RESPONSE = "agent.timeline.set_subscription.response";
const TIMELINE_REQUEST = "fetch_agent_timeline_request";
const TIMELINE_RESPONSE = "fetch_agent_timeline_response";
/**
 * `FRESHNESS_CHECK_QUIET_MS` is 500: an opening check unanswered that long reports Updating messages by
 * design, however long the daemon takes. The app starts that wait just before it sends the question
 * this helper times, so the bound stops short of 500.
 */
const QUIET_WINDOW_FLOOR_MS = 300;

export interface TimelineRequestCounts {
  agentId?: string;
  after: number;
  tail: number;
  subscriptions: number;
  fetches: number;
}

export interface BackgroundTimelineTurns {
  firstPrompt: string;
  newestPrompt: string;
}

function backgroundPrompt(index: number): string {
  return `timeline-resume-background-${index}: emit 1 coalesced agent stream updates`;
}

export async function commitTimelineTurnsWhileDisconnected(
  agent: LongTimelineAgent,
  count: number,
): Promise<BackgroundTimelineTurns> {
  for (let index = 0; index < count; index += 1) {
    await agent.client.sendAgentMessage(agent.agentId, backgroundPrompt(index));
    await agent.client.waitForFinish(agent.agentId, 15_000);
  }
  return {
    firstPrompt: backgroundPrompt(0),
    newestPrompt: backgroundPrompt(count - 1),
  };
}

export function rememberTimelineRequestCounts(
  gate: DaemonWebSocketGate,
  agentId?: string,
): TimelineRequestCounts {
  return {
    agentId,
    after: gate.getTimelineRequestCount("after", agentId),
    tail: gate.getTimelineRequestCount("tail", agentId),
    subscriptions: gate.getClientRequestCount(SUBSCRIPTION_REQUEST),
    fetches: gate.getClientRequestCount(TIMELINE_REQUEST),
  };
}

export function expectResumeAnsweredWithoutFetch(
  gate: DaemonWebSocketGate,
  before: TimelineRequestCounts,
): void {
  expect(gate.getTimelineRequestCount("after", before.agentId) - before.after).toBe(0);
  expect(gate.getTimelineRequestCount("tail", before.agentId) - before.tail).toBe(0);
}

/** Resolves once the daemon has told the app where this chat stands, whichever way it asked. */
export async function waitForResumeAnswer(
  gate: DaemonWebSocketGate,
  before: TimelineRequestCounts,
): Promise<void> {
  await Promise.race([
    gate.waitForServerMessage(SUBSCRIPTION_RESPONSE, before.subscriptions + 1),
    gate.waitForServerMessage(TIMELINE_RESPONSE, before.fetches + 1),
  ]);
}

interface UpdatingToastTiming {
  askedAt: number | null;
  shownAt: number | null;
}

declare global {
  interface Window {
    __updatingToastTiming?: UpdatingToastTiming;
  }
}

/** Runs in the page: times the freshness question and the toast's first commit on its own clock. */
function recordUpdatingToastTiming(): void {
  const noteToast = (timing: UpdatingToastTiming) => {
    if (document.querySelector('[data-testid="agent-updating-toast"]') === null) return;
    timing.shownAt ??= performance.now();
  };
  const existing = window.__updatingToastTiming;
  if (existing) {
    existing.askedAt = null;
    existing.shownAt = null;
    noteToast(existing);
    return;
  }
  const timing: UpdatingToastTiming = { askedAt: null, shownAt: null };
  window.__updatingToastTiming = timing;
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function sendRecordingQuestion(data) {
    if (
      typeof data === "string" &&
      data.includes("agent.timeline.set_subscription.request") &&
      data.includes('"agentIds":["')
    ) {
      timing.askedAt ??= performance.now();
    }
    return send.call(this, data);
  };
  new MutationObserver(() => noteToast(timing)).observe(document, {
    childList: true,
    subtree: true,
  });
  noteToast(timing);
}

/** A toast may only follow an unanswered question; nothing about the daemon's speed changes that. */
async function expectToastWaitedForTheDaemon(page: Page): Promise<void> {
  await waitForNextPaint(page);
  const showedTooSoon = await page.evaluate((floorMs) => {
    const { askedAt, shownAt } = window.__updatingToastTiming as UpdatingToastTiming;
    if (shownAt === null) return false;
    return askedAt === null || shownAt - askedAt < floorMs;
  }, QUIET_WINDOW_FLOOR_MS);
  expect(showedTooSoon, "the Updating messages toast did not wait for the daemon").toBe(false);
}

/** Records every appearance of the toast, including one that lasts a single commit. */
export async function watchForUpdatingToast(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(recordUpdatingToastTiming);
  return () => expectToastWaitedForTheDaemon(page);
}

/** Reopens the app on this chat, recording the toast from the first paint of the new page. */
export async function reopenAppWatchingForUpdatingToast(page: Page): Promise<() => Promise<void>> {
  await page.addInitScript(recordUpdatingToastTiming);
  await page.reload();
  return () => expectToastWaitedForTheDaemon(page);
}

/** Opens persisted history with the daemon's freshness answer held. */
export async function reopenWithFreshnessCheckUnanswered(
  page: Page,
  gate: DaemonWebSocketGate,
  agent: LongTimelineAgent,
): Promise<void> {
  // A cold open needs a persisted authoritative cursor to ask a freshness question.
  await expect
    .poll(async () => {
      const cache = await readReplicaCache(page);
      return cache?.hosts
        ?.flatMap((host) => host.timelines)
        .find((timeline) => timeline.agentId === agent.agentId)?.range?.endSeq;
    })
    .toBeGreaterThan(0);
  gate.holdNextClientRequest(SUBSCRIPTION_REQUEST);
  await page.reload();
  await expect(page.getByText(agent.newestPrompt, { exact: true })).toBeVisible();
  await gate.waitForHeldClientRequest();
  await expect(page.getByRole("alert").filter({ hasText: "Updating messages" })).toBeVisible();
}

export async function answerFreshnessCheck(page: Page, gate: DaemonWebSocketGate): Promise<void> {
  gate.releaseHeldClientRequest();
  await expect(page.getByRole("alert").filter({ hasText: "Updating messages" })).toHaveCount(0);
}

async function waitForNextPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export async function hideTabAndReturn(page: Page): Promise<void> {
  await setTabVisibility(page, "hidden");
  await waitForNextPaint(page);
  await setTabVisibility(page, "visible");
}

export function expectResumeOverflowFallsBackToOneTail(
  gate: DaemonWebSocketGate,
  before: TimelineRequestCounts,
): void {
  expect(gate.getTimelineRequestCount("after", before.agentId) - before.after).toBe(1);
  expect(gate.getTimelineRequestCount("tail", before.agentId) - before.tail).toBe(1);
}

export async function disconnectViewedTimeline(
  page: Page,
  gate: DaemonWebSocketGate,
): Promise<void> {
  await gate.drop();
  await expectReconnectingToastVisible(page);
}

export async function restoreViewedTimelineHoldingCatchUp(
  page: Page,
  gate: DaemonWebSocketGate,
): Promise<void> {
  gate.holdNextServerMessage(TIMELINE_RESPONSE);
  gate.restore();
  await gate.waitForHeldServerMessage();
  await expectReconnectingToastGone(page);
  await expect(page.getByRole("alert").filter({ hasText: "Updating messages" })).toBeVisible();
}

export async function releaseHeldCatchUp(page: Page, gate: DaemonWebSocketGate): Promise<void> {
  gate.releaseHeldServerMessage();
  await expect(page.getByRole("alert").filter({ hasText: "Updating messages" })).toHaveCount(0);
}

export async function restoreViewedTimelineWithHeldResponse(
  page: Page,
  gate: DaemonWebSocketGate,
): Promise<void> {
  await restoreViewedTimelineHoldingCatchUp(page, gate);
  await releaseHeldCatchUp(page, gate);
}

export async function restoreUnchangedViewedTimeline(
  page: Page,
  gate: DaemonWebSocketGate,
): Promise<void> {
  gate.restore();
  await expectReconnectingToastGone(page);
}
