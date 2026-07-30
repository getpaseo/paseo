import type { Page } from "@playwright/test";
import { expect, test as baseTest } from "./fixtures";
import { expectAgentIdle } from "./helpers/agent-stream";
import { expectComposerVisible, submitMessage } from "./helpers/composer";
import { clickNewChat, gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace } from "./helpers/seed-client";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "./helpers/mock-agent";
import { installDaemonWebSocketGate } from "./helpers/daemon-websocket-gate";

interface FrameRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface ElementFrame {
  mounted: boolean;
  visible: boolean;
  painted: boolean;
  rect: FrameRect | null;
  opacity: number | null;
  backgroundColor: string | null;
}

interface ContentChildFrame extends ElementFrame {
  key: string;
  text: string;
}

interface TurnFrame {
  at: number;
  userRow: ElementFrame;
  footerRow: ElementFrame;
  spinner: ElementFrame;
  interruptControl: ElementFrame;
  composer: ElementFrame & { value: string | null };
  contentChildren: ContentChildFrame[];
  scroll: ElementFrame & {
    scrollTop: number | null;
    clientHeight: number | null;
    scrollHeight: number | null;
  };
}

declare global {
  interface Window {
    __consecutiveTurnFrames?: { active: boolean; frames: TurnFrame[] };
  }
}

const test = baseTest.extend<{ streamingAgent: MockAgentWorkspace }>({
  streamingAgent: async ({ page: _page }, provide) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "consecutive-ten-second-turns-",
      title: "Consecutive ten-second turns",
      model: "ten-second-stream",
      initialPrompt: "emit 100 coalesced agent stream updates",
    });
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await provide(agent);
    await agent.cleanup();
  },
});

async function recordTurnFrames(page: Page, prompt: string): Promise<void> {
  await page.evaluate((promptText) => {
    const state = { active: true, frames: [] as TurnFrame[] };
    const emptyElement = (): ElementFrame => ({
      mounted: false,
      visible: false,
      painted: false,
      rect: null,
      opacity: null,
      backgroundColor: null,
    });
    const rectOf = (element: Element): FrameRect => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    };
    const intersects = (first: FrameRect, second: FrameRect) =>
      first.bottom > second.top &&
      first.top < second.bottom &&
      first.right > second.left &&
      first.left < second.right;
    const windowRect: FrameRect = {
      top: 0,
      right: innerWidth,
      bottom: innerHeight,
      left: 0,
      width: innerWidth,
      height: innerHeight,
    };
    const hasColor = (color: string) =>
      color !== "" && color !== "none" && color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
    const isVisible = (element: Element, clip?: Element | null) => {
      const rect = rectOf(element);
      return (
        element.isConnected &&
        element.checkVisibility() &&
        rect.width > 0 &&
        rect.height > 0 &&
        intersects(rect, windowRect) &&
        (!clip || intersects(rect, rectOf(clip)))
      );
    };
    const isPainted = (element: Element, clip?: Element | null) => {
      if (!isVisible(element, clip)) return false;
      return [element, ...Array.from(element.querySelectorAll("*"))].some((candidate) => {
        if (!isVisible(candidate, clip)) return false;
        const style = getComputedStyle(candidate);
        if (Number(style.opacity) <= 0) return false;
        if (hasColor(style.backgroundColor)) return true;
        if (candidate.textContent?.trim() && hasColor(style.color)) return true;
        if (candidate instanceof SVGElement) {
          const fill = style.fill || candidate.getAttribute("fill") || "";
          const stroke = style.stroke || candidate.getAttribute("stroke") || "";
          return hasColor(fill) || hasColor(stroke);
        }
        return candidate instanceof HTMLImageElement || candidate instanceof HTMLCanvasElement;
      });
    };
    const snapshot = (
      element: Element | null | undefined,
      clip?: Element | null,
      painted?: boolean,
    ): ElementFrame => {
      if (!element?.isConnected) return emptyElement();
      const style = getComputedStyle(element);
      return {
        mounted: true,
        visible: isVisible(element, clip),
        painted: painted ?? isPainted(element, clip),
        rect: rectOf(element),
        opacity: Number(style.opacity),
        backgroundColor: style.backgroundColor,
      };
    };
    const unionRect = (elements: Element[]): FrameRect | null => {
      if (elements.length === 0) return null;
      const rects = elements.map(rectOf);
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      const left = Math.min(...rects.map((rect) => rect.left));
      return { top, right, bottom, left, width: right - left, height: bottom - top };
    };
    const spinnerSnapshot = (
      footer: Element | null | undefined,
      clip: Element | null,
    ): ElementFrame => {
      const dots = Array.from(footer?.querySelectorAll("*") ?? []).filter((candidate) =>
        hasColor(getComputedStyle(candidate).backgroundColor),
      );
      if (dots.length === 0) return emptyElement();
      const opacities = dots.map((dot) => Number(getComputedStyle(dot).opacity));
      return {
        mounted: true,
        visible: dots.some((dot) => isVisible(dot, clip)),
        painted: dots.some((dot, index) => opacities[index] > 0 && isVisible(dot, clip)),
        rect: unionRect(dots),
        opacity: Math.max(...opacities),
        backgroundColor: getComputedStyle(dots[0]).backgroundColor,
      };
    };
    const sample = () => {
      const viewport = Array.from(
        document.querySelectorAll('[data-testid="agent-chat-scroll"]'),
      ).find((candidate) => isVisible(candidate));
      const promptRow = Array.from(
        viewport?.querySelectorAll('[data-testid="user-message"]') ?? [],
      ).find((candidate) => candidate.textContent?.includes(promptText));
      const footer = Array.from(
        viewport?.querySelectorAll('[data-testid="turn-working-indicator"]') ?? [],
      )[0];
      const spinner = spinnerSnapshot(footer, viewport ?? null);
      const footerRow = footer?.parentElement;
      const composer = Array.from(
        document.querySelectorAll('[aria-label="Message agent..."]'),
      ).find((candidate) => isVisible(candidate));
      const composerRoot = composer?.closest('[data-testid="message-input-root"]');
      const interrupt = Array.from(
        composerRoot?.querySelectorAll('[role="button"][aria-label]') ?? [],
      ).find((candidate) =>
        /stop agent|canceling agent/i.test(candidate.getAttribute("aria-label") ?? ""),
      );
      const scrollFrame = snapshot(viewport);
      const contentChildren = Array.from(viewport?.firstElementChild?.children ?? []).map(
        (child, index): ContentChildFrame =>
          Object.assign(snapshot(child, viewport), {
            key:
              (child.querySelector('[data-testid="turn-working-indicator"]')
                ? "turn-footer"
                : (child.getAttribute("data-history-row-id") ??
                  child.getAttribute("data-testid"))) ?? `child-${index}`,
            text: child.textContent?.trim().slice(0, 120) ?? "",
          }),
      );
      state.frames.push({
        at: performance.now(),
        userRow: snapshot(promptRow, viewport),
        footerRow: snapshot(footerRow, viewport, spinner.painted),
        spinner,
        interruptControl: snapshot(interrupt),
        composer: {
          ...snapshot(composerRoot ?? composer),
          value:
            composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement
              ? composer.value
              : null,
        },
        contentChildren,
        scroll: {
          ...scrollFrame,
          scrollTop: viewport instanceof HTMLElement ? viewport.scrollTop : null,
          clientHeight: viewport instanceof HTMLElement ? viewport.clientHeight : null,
          scrollHeight: viewport instanceof HTMLElement ? viewport.scrollHeight : null,
        },
      });
      if (state.active) scheduleAfterNextPaint();
    };
    const scheduleAfterNextPaint = () => {
      requestAnimationFrame(() => setTimeout(sample, 0));
    };
    window.__consecutiveTurnFrames = state;
    scheduleAfterNextPaint();
  }, prompt);
}

async function waitForRecordedFrames(
  page: Page,
  predicate: "user-visible" | "turn-running",
  count: number,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (input) => {
          const frames = window.__consecutiveTurnFrames?.frames ?? [];
          return frames.filter((frame) => {
            if (input.predicate === "user-visible") return frame.userRow.visible;
            return (
              frame.interruptControl.painted && frame.footerRow.painted && frame.spinner.painted
            );
          }).length;
        },
        { predicate },
      ),
    )
    .toBeGreaterThanOrEqual(count);
}

async function recordPaintsFor(page: Page, durationMs: number): Promise<void> {
  const until = await page.evaluate((duration) => performance.now() + duration, durationMs);
  await expect
    .poll(() => page.evaluate(() => window.__consecutiveTurnFrames?.frames.at(-1)?.at ?? 0))
    .toBeGreaterThanOrEqual(until);
}

async function stopTurnFrameRecording(page: Page): Promise<TurnFrame[]> {
  return page.evaluate(() => {
    const state = window.__consecutiveTurnFrames;
    if (!state) throw new Error("Turn frames were never recorded");
    state.active = false;
    return state.frames;
  });
}

function formatFrames(frames: TurnFrame[], centers: number | number[]): string {
  const indexes = new Set<number>();
  for (const center of Array.isArray(centers) ? centers : [centers]) {
    for (let index = Math.max(0, center - 3); index <= center + 3; index += 1) {
      if (index < frames.length) indexes.add(index);
    }
  }
  return Array.from(indexes)
    .sort((left, right) => left - right)
    .map((index) => `frame ${index}: ${JSON.stringify(frames[index])}`)
    .join("\n");
}

function expectRowContinuity(frames: TurnFrame[]): void {
  const first = frames.findIndex((frame) => hasPaintedLayout(frame.userRow));
  const baseline = frames[first]?.userRow.rect?.top;
  const disappeared = frames.findIndex(
    (frame, index) => index > first && !hasPaintedLayout(frame.userRow),
  );
  const reappeared = frames.findIndex(
    (frame, index) => index > disappeared && disappeared >= 0 && hasPaintedLayout(frame.userRow),
  );
  const shifted = frames.findIndex(
    (frame, index) =>
      index > first &&
      hasPaintedLayout(frame.userRow) &&
      baseline !== undefined &&
      Math.abs((frame.userRow.rect?.top ?? baseline) - baseline) > 1,
  );
  const violations = [
    ...(first < 0 ? ["submitted row never became visible"] : []),
    ...(disappeared >= 0
      ? [
          `submitted row disappeared for ${Math.max(0, reappeared - disappeared)} recorded frames (${Math.max(0, (frames[reappeared]?.at ?? frames.at(-1)?.at ?? 0) - frames[disappeared].at).toFixed(1)}ms) before authoritative recovery`,
        ]
      : []),
    ...(shifted >= 0
      ? [
          `submitted row moved from ${baseline?.toFixed(1)} to ${frames[shifted].userRow.rect?.top.toFixed(1)}`,
        ]
      : []),
  ];
  let failure = Math.max(0, first);
  if (shifted >= 0) failure = shifted;
  if (disappeared >= 0) failure = disappeared;
  expect(
    violations,
    `transition violations:\n${formatFrames(frames, [failure, Math.max(failure, reappeared)])}`,
  ).toEqual([]);
}

interface FrameViolation {
  frame: number;
  reason: string;
}

function geometryChanged(
  value: number | null | undefined,
  expected: number | null | undefined,
): boolean {
  if (value == null || expected == null) return true;
  return Math.abs(value - expected) > 1;
}

function hasPaintedLayout(element: ElementFrame): boolean {
  return [element.mounted, element.visible, element.painted].every(Boolean);
}

function violationsForChecks(
  frame: number,
  checks: Array<{ passes: boolean; reason: string }>,
): FrameViolation[] {
  return checks.filter(({ passes }) => !passes).map(({ reason }) => ({ frame, reason }));
}

function collectElementViolations(
  frame: TurnFrame,
  baseline: TurnFrame | undefined,
  index: number,
): FrameViolation[] {
  return violationsForChecks(index, [
    {
      passes: hasPaintedLayout(frame.userRow),
      reason: "submitted row left the painted layout",
    },
    {
      passes: !geometryChanged(frame.userRow.rect?.top, baseline?.userRow.rect?.top),
      reason: "submitted row moved vertically",
    },
    {
      passes: [hasPaintedLayout(frame.footerRow), (frame.footerRow.rect?.height ?? 0) > 0].every(
        Boolean,
      ),
      reason: "footer row was absent from the painted layout",
    },
    {
      passes: [
        geometryChanged(frame.footerRow.rect?.top, baseline?.footerRow.rect?.top),
        geometryChanged(frame.footerRow.rect?.height, baseline?.footerRow.rect?.height),
      ].every((hasChanged) => !hasChanged),
      reason: "footer geometry moved",
    },
    {
      passes: hasPaintedLayout(frame.spinner),
      reason: "working spinner was not painted",
    },
    {
      passes: [hasPaintedLayout(frame.composer), frame.composer.value === ""].every(Boolean),
      reason: "composer was not painted and empty",
    },
    {
      passes: [
        geometryChanged(frame.composer.rect?.top, baseline?.composer.rect?.top),
        geometryChanged(frame.composer.rect?.height, baseline?.composer.rect?.height),
      ].every((hasChanged) => !hasChanged),
      reason: "composer geometry moved",
    },
  ]);
}

function collectScrollViolations(
  frame: TurnFrame,
  baseline: TurnFrame | undefined,
  index: number,
): FrameViolation[] {
  return violationsForChecks(index, [
    {
      passes: [
        frame.scroll.mounted,
        frame.scroll.visible,
        !geometryChanged(frame.scroll.rect?.top, baseline?.scroll.rect?.top),
        !geometryChanged(frame.scroll.rect?.height, baseline?.scroll.rect?.height),
        !geometryChanged(frame.scroll.clientHeight, baseline?.scroll.clientHeight),
      ].every(Boolean),
      reason: "scroll viewport geometry moved",
    },
    {
      passes: [
        geometryChanged(frame.scroll.scrollTop, baseline?.scroll.scrollTop),
        geometryChanged(frame.scroll.scrollHeight, baseline?.scroll.scrollHeight),
      ].every((hasChanged) => !hasChanged),
      reason: "scroll content metrics moved",
    },
  ]);
}

function collectContentViolations(
  frame: TurnFrame,
  stableContentChildren: Map<string, ContentChildFrame>,
  index: number,
): FrameViolation[] {
  return Array.from(stableContentChildren).flatMap(([key, expected]) => {
    const child = frame.contentChildren.find((candidate) => candidate.key === key);
    return violationsForChecks(index, [
      {
        passes: [
          Boolean(child?.mounted),
          !geometryChanged(child?.rect?.top, expected.rect?.top),
          !geometryChanged(child?.rect?.bottom, expected.rect?.bottom),
          !geometryChanged(child?.rect?.height, expected.rect?.height),
        ].every(Boolean),
        reason: `content row ${key} geometry moved`,
      },
    ]);
  });
}

function expectAtomicIdleToRunningTransition(frames: TurnFrame[]): void {
  const first = frames.findIndex((frame) => frame.userRow.visible);
  const running = frames.findIndex(
    (frame, index) =>
      index >= first &&
      frame.interruptControl.painted &&
      frame.footerRow.painted &&
      frame.spinner.painted,
  );
  const transition = frames.slice(first);
  const baseline = transition[0];
  const violations: FrameViolation[] = [];
  const stableContentChildren = new Map(
    baseline?.contentChildren
      .filter(({ key }) => key !== "turn-footer")
      .map((child) => [child.key, child]),
  );
  if (first < 0) violations.push({ frame: 0, reason: "submitted row never became visible" });
  if (running < 0) violations.push({ frame: Math.max(first, 0), reason: "turn never visibly ran" });
  for (const [offset, frame] of transition.entries()) {
    const index = first + offset;
    violations.push(...collectElementViolations(frame, baseline, index));
    violations.push(...collectScrollViolations(frame, baseline, index));
    violations.push(...collectContentViolations(frame, stableContentChildren, index));
  }
  for (let offset = 1; offset < transition.length; offset += 1) {
    const before = transition[offset - 1];
    const after = transition[offset];
    const footerEnteredLayout = [
      (before.footerRow.rect?.height ?? 0) <= 0,
      (after.footerRow.rect?.height ?? 0) > 0,
    ].every(Boolean);
    if (footerEnteredLayout) {
      violations.push({
        frame: first + offset,
        reason: "footer height changed from zero to non-zero",
      });
    }
  }
  const failure = violations[0]?.frame ?? Math.max(first, 0);
  expect(
    violations,
    `transition violations:\n${violations.map(({ frame, reason }) => `frame ${frame}: ${reason}`).join("\n")}\n\nframe record:\n${formatFrames(frames, [failure, running])}`,
  ).toEqual([]);
}

async function recordDelayedRunningTransition(
  page: Page,
  agent: MockAgentWorkspace,
): Promise<TurnFrame[]> {
  const gate = await installDaemonWebSocketGate(page);
  await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
  await expectAgentIdle(page);
  await expect(page.getByRole("button", { name: "Copy turn" })).toHaveCount(1);

  const prompt = "Second prompt keeps streaming.";
  gate.holdNextAgentUpdate(agent.agentId, "running");
  gate.setMessageSubmissionDispositionStripped(true);
  gate.setAgentStreamEventSuppressed("turn_started", true);
  gate.setAgentStreamItemSuppressed("assistant_message", true);
  await recordTurnFrames(page, prompt);
  await submitMessage(page, prompt);
  await gate.waitForHeldServerMessage();

  let released = false;
  try {
    await expect(page.getByTestId("user-message").filter({ hasText: prompt })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toHaveValue("");
    await Promise.all([
      gate.waitForAgentStreamItem("user_message"),
      gate.waitForServerMessage("send_agent_message_response"),
    ]);
    await recordPaintsFor(page, 80);
    gate.releaseHeldServerMessage();
    released = true;
    await waitForRecordedFrames(page, "turn-running", 3);
    const frames = await stopTurnFrameRecording(page);
    gate.setMessageSubmissionDispositionStripped(false);
    gate.setAgentStreamEventSuppressed("turn_started", false);
    gate.setAgentStreamItemSuppressed("assistant_message", false);
    return frames;
  } finally {
    if (!released) gate.releaseHeldServerMessage();
    gate.setMessageSubmissionDispositionStripped(false);
    gate.setAgentStreamEventSuppressed("turn_started", false);
    gate.setAgentStreamItemSuppressed("assistant_message", false);
  }
}

// The first prompt of a brand new agent is submitted before the agent exists, so the
// authoritative timeline arrives after the row is already on screen. That is the only
// path where hydration can move an already-visible message.
test("keeps the first prompt of a new agent in place through authoritative hydration", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "new-agent-first-prompt-" });
  try {
    await page.addInitScript(() => {
      localStorage.setItem(
        "@paseo:create-agent-preferences",
        JSON.stringify({
          provider: "mock",
          providerPreferences: {
            mock: { mode: "load-test", model: "ten-second-stream" },
          },
        }),
      );
    });
    const gate = await installDaemonWebSocketGate(page);
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await expectComposerVisible(page);

    const prompt = "Delay synthetic user message by 300ms.";
    await recordTurnFrames(page, prompt);
    await submitMessage(page, prompt);

    const submittedRow = page.getByTestId("user-message").filter({ hasText: prompt }).first();
    await expect(submittedRow).toBeVisible();
    await gate.waitForAgentStreamItem("user_message");
    await recordPaintsFor(page, 80);
    expectRowContinuity(await stopTurnFrameRecording(page));
  } finally {
    await workspace.cleanup();
  }
});

test("commits a follow-up prompt and running footer in one painted frame", async ({
  page,
  streamingAgent,
}) => {
  const frames = await recordDelayedRunningTransition(page, streamingAgent);
  expectAtomicIdleToRunningTransition(frames);
});
