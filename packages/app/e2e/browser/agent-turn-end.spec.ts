import type { Page } from "@playwright/test";
import { expect, test as baseTest } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import { submitMessage } from "../support/helpers/composer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

// A turn ends with its final reply, `turn_completed`, and the idle status snapshot arriving
// within a few milliseconds of each other. These tests hold all three, let the running
// turn paint, then release them together and sample every painted frame.

interface Box {
  top: number;
  height: number;
}

interface TurnEndFrame {
  at: number;
  running: boolean;
  footer: Box | null;
  userRow: Box | null;
  replyVisible: boolean;
}

declare global {
  interface Window {
    __turnEndFrames?: { active: boolean; frames: TurnEndFrame[] };
  }
}

const test = baseTest.extend<{ agent: MockAgentWorkspace }>({
  agent: async ({ page: _page }, provide) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "turn-end-",
      title: "Turn end",
      initialPrompt: "emit 4 tool agent stream updates",
    });
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await provide(agent);
    await agent.cleanup();
  },
});

async function recordTurnEndFrames(
  page: Page,
  input: { prompt: string; reply: string | null },
): Promise<void> {
  await page.evaluate(({ prompt, reply }) => {
    const state = { active: true, frames: [] as TurnEndFrame[] };
    const isVisible = (element: Element | null | undefined) => Boolean(element?.checkVisibility());
    const boxOf = (element: Element | null | undefined): Box | null => {
      if (!element || !isVisible(element)) return null;
      const rect = element.getBoundingClientRect();
      return rect.height > 0 ? { top: rect.top, height: rect.height } : null;
    };
    const sample = () => {
      const viewport = Array.from(
        document.querySelectorAll('[data-testid="agent-chat-scroll"]'),
      ).find((candidate) => isVisible(candidate));
      const footers = Array.from(viewport?.querySelectorAll('[data-testid="turn-footer"]') ?? [])
        .map(boxOf)
        .filter((box): box is Box => box !== null)
        .sort((left, right) => left.top - right.top);
      const userRow = Array.from(
        viewport?.querySelectorAll('[data-testid="user-message"]') ?? [],
      ).find((candidate) => candidate.textContent?.includes(prompt));
      const replyRow =
        reply === null
          ? undefined
          : Array.from(viewport?.querySelectorAll('[data-testid="assistant-message"]') ?? []).find(
              (candidate) => candidate.textContent?.includes(reply),
            );
      state.frames.push({
        at: performance.now(),
        running: Boolean(viewport?.querySelector('[data-testid="turn-working-indicator"]')),
        footer: footers.at(-1) ?? null,
        userRow: boxOf(userRow),
        replyVisible: boxOf(replyRow) !== null,
      });
      if (state.active) requestAnimationFrame(() => setTimeout(sample, 0));
    };
    window.__turnEndFrames = state;
    requestAnimationFrame(() => setTimeout(sample, 0));
  }, input);
}

async function recordPaintsFor(page: Page, durationMs: number): Promise<void> {
  const until = await page.evaluate((duration) => performance.now() + duration, durationMs);
  await expect
    .poll(() => page.evaluate(() => window.__turnEndFrames?.frames.at(-1)?.at ?? 0))
    .toBeGreaterThanOrEqual(until);
}

async function stopRecording(page: Page): Promise<TurnEndFrame[]> {
  return page.evaluate(() => {
    const state = window.__turnEndFrames;
    if (!state) throw new Error("Turn end frames were not recorded");
    state.active = false;
    return state.frames;
  });
}

async function recordTurnEnd(
  page: Page,
  agent: MockAgentWorkspace,
  input: { prompt: string; reply: string | null },
): Promise<TurnEndFrame[]> {
  const gate = await installDaemonWebSocketGate(page);
  await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
  await expectAgentIdle(page);

  if (input.reply === null) {
    gate.setAgentStreamItemSuppressed("assistant_message", true);
  } else {
    gate.holdNextAgentStreamItem("assistant_message");
  }
  gate.holdNextAgentStreamEvent("turn_completed");
  // The daemon sends more than one idle snapshot; hold the first and drop the rest until release.
  gate.holdNextAgentUpdate(agent.agentId, "idle");
  gate.setServerMessageSuppressed("agent_update", true);
  await recordTurnEndFrames(page, input);
  await submitMessage(page, input.prompt);
  await Promise.all([
    input.reply === null ? Promise.resolve() : gate.waitForHeldAgentStreamItem("assistant_message"),
    gate.waitForHeldAgentStreamEvent("turn_completed"),
    gate.waitForHeldAgentUpdate(agent.agentId, "idle"),
  ]);
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await recordPaintsFor(page, 200);

  if (input.reply !== null) gate.releaseHeldAgentStreamItem("assistant_message");
  gate.releaseHeldAgentStreamEvent("turn_completed");
  gate.releaseHeldAgentUpdate(agent.agentId, "idle");
  gate.setServerMessageSuppressed("agent_update", false);
  await expectAgentIdle(page);
  await recordPaintsFor(page, 300);
  return stopRecording(page);
}

function describeFrames(frames: TurnEndFrame[]): string {
  return frames
    .map(
      (frame, index) =>
        `${index}: ${frame.running ? "running " : "complete"} footer=${
          frame.footer ? `${frame.footer.top.toFixed(1)}+${frame.footer.height.toFixed(1)}` : "none"
        } prompt=${frame.userRow?.top.toFixed(1) ?? "none"} reply=${frame.replyVisible}`,
    )
    .join("\n");
}

function expectSteadyTurnEnd(frames: TurnEndFrame[], input: { reply: string | null }): void {
  const firstRunning = frames.findIndex((frame) => frame.running && frame.footer !== null);
  const firstComplete = frames.findIndex((frame, index) => index > firstRunning && !frame.running);
  const record = `frames:\n${describeFrames(frames)}`;
  expect(firstRunning, record).toBeGreaterThanOrEqual(0);
  expect(firstComplete, record).toBeGreaterThan(firstRunning);

  const transition = frames.slice(firstRunning);
  const runningHeight = transition[0].footer?.height;
  expect(
    transition.map((frame) => frame.footer?.height ?? null),
    `the footer must stay painted at one height\n${record}`,
  ).toEqual(transition.map(() => runningHeight));
  if (input.reply !== null) {
    expect(
      frames.slice(firstComplete).every((frame) => frame.replyVisible),
      `a completed turn must show its reply in the same frame\n${record}`,
    ).toBe(true);
  }
  // Tool rows land while the turn runs; only the turn end itself must be one step.
  const ending = frames.slice(firstComplete - 1);
  const promptMoves = ending
    .slice(1)
    .filter((frame, index) => frame.userRow?.top !== ending[index].userRow?.top);
  expect(
    promptMoves.length,
    `the prompt must move at most once as the turn ends\n${record}`,
  ).toBeLessThanOrEqual(1);
}

test.describe("Turn end", () => {
  test("ends a plain reply without moving or dropping its footer", async ({ page, agent }) => {
    const input = { prompt: "emit 1 coalesced agent stream updates", reply: "stress-update-0" };
    expectSteadyTurnEnd(await recordTurnEnd(page, agent, input), input);
  });

  test("ends a tool turn with its reply and completed footer together", async ({ page, agent }) => {
    const input = { prompt: "emit 3 tool agent stream updates", reply: "Completed 3 commands" };
    expectSteadyTurnEnd(await recordTurnEnd(page, agent, input), input);
  });

  test("keeps the footer height when a turn ends on a tool call", async ({ page, agent }) => {
    const input = { prompt: "emit 2 tool agent stream updates", reply: null };
    expectSteadyTurnEnd(await recordTurnEnd(page, agent, input), input);
  });
});

async function expectTimingInsideFooter(page: Page): Promise<void> {
  const label = page.getByRole("button", { name: /^Worked for/ }).last();
  const paintedLines = await label.getByTestId("turn-footer-timing-label").evaluate((element) => {
    const labelBounds = element.parentElement!.getBoundingClientRect();
    const rowBounds = element.closest('[data-testid="turn-footer"]')!.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const lines: boolean[] = [];
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) {
        lines.push(
          rect.left >= Math.max(rowBounds.left, labelBounds.left) - 0.5 &&
            rect.right <= Math.min(rowBounds.right, labelBounds.right) + 0.5 &&
            rect.top >= Math.max(rowBounds.top, labelBounds.top) - 0.5 &&
            rect.bottom <= Math.min(rowBounds.bottom, labelBounds.bottom) + 0.5,
        );
      }
    }
    return lines;
  });
  expect(paintedLines.length).toBeGreaterThan(0);
  expect(paintedLines.every(Boolean)).toBe(true);
}

async function expectFooterWithinWidth(page: Page, width: number): Promise<void> {
  const footer = page.getByTestId("turn-footer").last();
  await footer.evaluate((element, availableWidth) => {
    element.style.width = `${availableWidth}px`;
  }, width);
  const label = page.getByRole("button", { name: /^Worked for/ }).last();
  await expect(label).toBeVisible();
  await expectTimingInsideFooter(page);
  const controls = footer.getByRole("button", { name: /Copy turn|Fork chat/ });
  const before = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    }),
  );
  const footerBefore = await footer.boundingBox();
  const labelBefore = await label.boundingBox();
  await label.hover({ position: { x: labelBefore!.width - 2, y: labelBefore!.height - 2 } });
  await expect(label.getByTestId("turn-footer-timing-label")).toContainText(/\d:\d\d/);
  expect(await label.boundingBox()).toMatchObject({
    x: labelBefore!.x,
    width: labelBefore!.width,
    height: labelBefore!.height,
  });
  expect(
    await controls.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      }),
    ),
  ).toEqual(before);
  expect(await footer.boundingBox()).toMatchObject({
    x: footerBefore!.x,
    y: footerBefore!.y,
    width: footerBefore!.width,
  });
  await expectTimingInsideFooter(page);
  await page.mouse.move(0, 0);
  await expect(label.getByTestId("turn-footer-timing-label")).toContainText("Worked for");
}

test("footer timing fits the chat column and swapping labels keeps controls in place", async ({
  page,
  agent,
}) => {
  await openAgentRoute(page, agent);
  await expectFooterWithinWidth(page, 140);
  await expectFooterWithinWidth(page, 150);
  await expectFooterWithinWidth(page, 300);
  await expectFooterWithinWidth(page, 880);
});

async function visibleFooterLeftEdges(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const viewport = Array.from(
      document.querySelectorAll('[data-testid="agent-chat-scroll"]'),
    ).find((candidate) => candidate.checkVisibility());
    return Array.from(viewport?.querySelectorAll('[data-testid="turn-footer"]') ?? [])
      .filter((footer) => footer.checkVisibility())
      .map((footer) => Math.round(footer.getBoundingClientRect().left));
  });
}

async function expectFootersInOneColumn(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const edges = await visibleFooterLeftEdges(page);
      return edges.length >= 2 && new Set(edges).size === 1 ? "one column" : edges;
    })
    .toBe("one column");
}

test("keeps the latest turn's footer in the chat column while it runs and after it ends", async ({
  page,
  agent,
}) => {
  // Wider than the chat's max width, so the column is centered with space on both sides.
  await page.setViewportSize({ width: 1600, height: 1000 });
  const gate = await installDaemonWebSocketGate(page);
  await openAgentRoute(page, agent);
  await expectAgentIdle(page);

  gate.holdNextAgentStreamEvent("turn_completed");
  gate.holdNextAgentUpdate(agent.agentId, "idle");
  gate.setServerMessageSuppressed("agent_update", true);
  await submitMessage(page, "emit 1 coalesced agent stream updates");
  await Promise.all([
    gate.waitForHeldAgentStreamEvent("turn_completed"),
    gate.waitForHeldAgentUpdate(agent.agentId, "idle"),
  ]);
  await expect(page.getByTestId("turn-working-indicator")).toBeVisible();
  await expectFootersInOneColumn(page);

  gate.releaseHeldAgentStreamEvent("turn_completed");
  gate.releaseHeldAgentUpdate(agent.agentId, "idle");
  gate.setServerMessageSuppressed("agent_update", false);
  await expectAgentIdle(page);
  await expect(page.getByTestId("turn-working-indicator")).toHaveCount(0);
  await expectFootersInOneColumn(page);
});
