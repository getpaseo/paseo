import { expect, type Page } from "@playwright/test";
import type { installDaemonWebSocketGate } from "./daemon-websocket-gate";
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

/** Records every appearance of the toast, including one that lasts a single commit. */
export async function watchForUpdatingToast(page: Page): Promise<() => Promise<void>> {
  const watch = await page.evaluateHandle(() => {
    let shown = false;
    const check = () => {
      shown ||= document.querySelector('[data-testid="agent-updating-toast"]') !== null;
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return {
      stop() {
        observer.disconnect();
        return shown;
      },
    };
  });
  return async () => {
    await waitForNextPaint(page);
    const shown = await watch.evaluate((recorder) => recorder.stop());
    await watch.dispose();
    expect(shown, "the Updating messages toast appeared").toBe(false);
  };
}

/** Reopens the app on this chat, recording the toast from the first paint of the new page. */
export async function reopenAppWatchingForUpdatingToast(page: Page): Promise<() => Promise<void>> {
  await page.addInitScript(() => {
    const recorder = window as Window & { updatingToastShown?: boolean };
    new MutationObserver(() => {
      recorder.updatingToastShown ||=
        document.querySelector('[data-testid="agent-updating-toast"]') !== null;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  return async () => {
    await waitForNextPaint(page);
    const shown = await page.evaluate(
      () => (window as Window & { updatingToastShown?: boolean }).updatingToastShown === true,
    );
    expect(shown, "the Updating messages toast appeared").toBe(false);
  };
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
