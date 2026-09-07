import { expect, type Page } from "@playwright/test";
import type { installDaemonWebSocketGate } from "./daemon-websocket-gate";
import type { LongTimelineAgent } from "./timeline-pagination";
import { expectReconnectingToastGone, expectReconnectingToastVisible } from "./workspace-ui";

type DaemonWebSocketGate = Awaited<ReturnType<typeof installDaemonWebSocketGate>>;

export interface TimelineRequestCounts {
  after: number;
  tail: number;
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

export function rememberTimelineRequestCounts(gate: DaemonWebSocketGate): TimelineRequestCounts {
  return {
    after: gate.getTimelineRequestCount("after"),
    tail: gate.getTimelineRequestCount("tail"),
  };
}

export function expectOneResumeCheckWithoutTail(
  gate: DaemonWebSocketGate,
  before: TimelineRequestCounts,
): void {
  expect(gate.getTimelineRequestCount("after") - before.after).toBe(1);
  expect(gate.getTimelineRequestCount("tail") - before.tail).toBe(0);
}

export function expectResumeOverflowFallsBackToOneTail(
  gate: DaemonWebSocketGate,
  before: TimelineRequestCounts,
): void {
  expect(gate.getTimelineRequestCount("after") - before.after).toBe(1);
  expect(gate.getTimelineRequestCount("tail") - before.tail).toBe(1);
}

export async function disconnectViewedTimeline(
  page: Page,
  gate: DaemonWebSocketGate,
): Promise<void> {
  await gate.drop();
  await expectReconnectingToastVisible(page);
}

export async function restoreViewedTimelineWithHeldResponse(
  page: Page,
  gate: DaemonWebSocketGate,
): Promise<void> {
  gate.holdNextServerMessage("fetch_agent_timeline_response");
  gate.restore();
  await gate.waitForHeldServerMessage();
  gate.releaseHeldServerMessage();
  await expectReconnectingToastGone(page);
}
