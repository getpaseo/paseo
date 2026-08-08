import type { Page } from "@playwright/test";
import { expect, test as baseTest } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import {
  attachImageFromMenu,
  expectAttachmentPill,
  expectComposerVisible,
  submitMessage,
} from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";

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
  attachment: ElementFrame;
  footerRow: ElementFrame;
  spinner: ElementFrame;
  agentTab: ElementFrame;
  tabProgress: ElementFrame;
  interruptControl: ElementFrame;
  primaryActionCount: number;
  composer: ElementFrame & { value: string | null };
  contentChildren: ContentChildFrame[];
  scroll: ElementFrame & {
    scrollTop: number | null;
    clientHeight: number | null;
    scrollHeight: number | null;
  };
}

interface ActivityCheckpoint {
  row: boolean;
  stop: boolean;
  footer: boolean;
  tabProgress: boolean;
  elapsed: boolean;
}

interface ActivityOracleState {
  phase: "waiting" | "observing" | "complete";
  checkpoints: ActivityCheckpoint[];
  observer: MutationObserver;
}

type RunningReleaseOrder = "turn-before-response" | "response-before-turn" | "snapshot-before-turn";

const FIRST_PROMPT_IMAGE = {
  name: "first-prompt.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
};

declare global {
  interface Window {
    __consecutiveTurnFrames?: { active: boolean; frames: TurnFrame[] };
    __activityContinuityOracle?: ActivityOracleState;
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
        const hasPaintedBorder = ["Top", "Right", "Bottom", "Left"].some(
          (side) =>
            Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
            hasColor(style.getPropertyValue(`border-${side.toLowerCase()}-color`)),
        );
        if (hasPaintedBorder) return true;
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
    const findImageAttachment = (row: Element | undefined) =>
      row?.querySelector('[role="button"][aria-label="Open image attachment"]');
    const findAgentTabState = () => {
      const agentTab = Array.from(
        document.querySelectorAll('[data-testid^="workspace-tab-agent_"]'),
      ).find((candidate) => isVisible(candidate));
      return {
        agentTab,
        tabProgress: agentTab?.querySelector('[role="progressbar"][aria-label="Agent running"]'),
      };
    };
    const countPrimaryActions = (composerRoot: Element | null | undefined) =>
      Array.from(composerRoot?.querySelectorAll('[role="button"][aria-label]') ?? []).filter(
        (candidate) =>
          /stop agent|canceling agent|interrupt agent|send message|send and interrupt|queue message/i.test(
            candidate.getAttribute("aria-label") ?? "",
          ) && isVisible(candidate),
      ).length;
    const sample = () => {
      const viewport = Array.from(
        document.querySelectorAll('[data-testid="agent-chat-scroll"]'),
      ).find((candidate) => isVisible(candidate));
      const promptRow = Array.from(
        viewport?.querySelectorAll('[data-testid="user-message"]') ?? [],
      ).find((candidate) => candidate.textContent?.includes(promptText));
      const attachment = findImageAttachment(promptRow);
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
      const primaryActionCount = countPrimaryActions(composerRoot);
      const { agentTab, tabProgress } = findAgentTabState();
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
        attachment: snapshot(attachment, viewport),
        footerRow: snapshot(footerRow, viewport, spinner.painted),
        spinner,
        agentTab: snapshot(agentTab),
        tabProgress: snapshot(tabProgress),
        interruptControl: snapshot(interrupt),
        primaryActionCount,
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
              frame.interruptControl.painted &&
              frame.footerRow.painted &&
              frame.spinner.painted &&
              frame.tabProgress.painted
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

async function installActivityContinuityOracle(page: Page, prompt: string): Promise<void> {
  await page.evaluate((promptText) => {
    const isVisible = (element: Element | null) => Boolean(element?.checkVisibility());
    const snapshot = (): ActivityCheckpoint => {
      const visibleAgentTab = Array.from(
        document.querySelectorAll('[data-testid^="workspace-tab-agent_"]'),
      ).find((candidate) => isVisible(candidate));
      return {
        row: Array.from(document.querySelectorAll('[data-testid="user-message"]')).some(
          (candidate) => candidate.textContent?.includes(promptText),
        ),
        stop: isVisible(document.querySelector('[role="button"][aria-label="Stop agent"]')),
        footer: isVisible(document.querySelector('[data-testid="turn-working-indicator"]')),
        tabProgress: isVisible(
          visibleAgentTab?.querySelector('[role="progressbar"][aria-label="Agent running"]') ??
            null,
        ),
        elapsed: isVisible(document.querySelector('[data-testid="turn-working-elapsed"]')),
      };
    };
    const state = {
      phase: "waiting" as ActivityOracleState["phase"],
      checkpoints: [] as ActivityCheckpoint[],
      observer: null as unknown as MutationObserver,
    };
    const observeCommit = () => {
      const checkpoint = snapshot();
      if (state.phase === "waiting" && checkpoint.row) {
        state.phase = "observing";
      }
      if (state.phase !== "observing") return;
      state.checkpoints.push(checkpoint);
      if (checkpoint.elapsed) {
        state.phase = "complete";
        state.observer.disconnect();
      }
    };
    state.observer = new MutationObserver(observeCommit);
    window.__activityContinuityOracle = state;
    state.observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }, prompt);
}

async function waitForActivityOracleArmed(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__activityContinuityOracle?.phase ?? "missing"))
    .not.toBe("waiting");
}

async function readActivityContinuityOracle(page: Page): Promise<ActivityCheckpoint[]> {
  return page.evaluate(() => {
    const state = window.__activityContinuityOracle;
    if (!state) throw new Error("Activity continuity oracle was never installed");
    state.observer.disconnect();
    return state.checkpoints;
  });
}

function expectActivityContinuity(checkpoints: ActivityCheckpoint[]): void {
  const incompleteActivityCheckpoints = checkpoints.filter(
    (checkpoint) => !checkpoint.stop || !checkpoint.footer || !checkpoint.tabProgress,
  );
  expect(checkpoints[0]?.row, "activity oracle never armed on the optimistic row").toBe(true);
  expect(
    incompleteActivityCheckpoints,
    `activity oracle observed row without full activity cluster:\n${JSON.stringify(incompleteActivityCheckpoints, null, 2)}\n\nall checkpoints:\n${JSON.stringify(checkpoints, null, 2)}`,
  ).toEqual([]);
  expect(
    checkpoints.slice(0, -1).filter((checkpoint) => checkpoint.elapsed),
    `activity oracle observed elapsed before its authoritative disarm checkpoint:\n${JSON.stringify(checkpoints, null, 2)}`,
  ).toEqual([]);
  expect(checkpoints.at(-1)?.elapsed, "activity oracle never observed authoritative elapsed").toBe(
    true,
  );
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
  const attachmentMissing = frames.findIndex(
    (frame, index) => index >= first && !hasPaintedLayout(frame.attachment),
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
    ...(attachmentMissing >= 0 ? ["submitted image attachment left the painted layout"] : []),
  ];
  let failure = Math.max(0, first);
  if (attachmentMissing >= 0) failure = attachmentMissing;
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
      passes: hasPaintedLayout(frame.tabProgress),
      reason: "selected tab running indicator was not painted",
    },
    {
      passes: hasPaintedLayout(frame.interruptControl),
      reason: "interrupt control was not painted",
    },
    {
      passes: frame.primaryActionCount === 1,
      reason: `expected one primary action, found ${frame.primaryActionCount}`,
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
      frame.spinner.painted &&
      frame.tabProgress.painted,
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

function expectSubmittedMessageHeightStable(frames: TurnFrame[]): void {
  const first = frames.findIndex((frame) => frame.userRow.visible);
  const baseline = frames[first]?.userRow.rect?.height;
  const changes = frames
    .slice(first)
    .flatMap((frame, offset) =>
      geometryChanged(frame.userRow.rect?.height, baseline)
        ? [`frame ${first + offset}: submitted row height changed`]
        : [],
    );
  expect(changes, `submitted message geometry changed:\n${changes.join("\n")}`).toEqual([]);
}

function expectAtomicFirstPromptTransition(frames: TurnFrame[]): void {
  expectRowContinuity(frames);
  const first = frames.findIndex((frame) => hasPaintedLayout(frame.userRow));
  const transition = frames.slice(first);
  const violations: FrameViolation[] = [];
  for (const [offset, frame] of transition.entries()) {
    const index = first + offset;
    violations.push(
      ...violationsForChecks(index, [
        {
          passes: hasPaintedLayout(frame.footerRow),
          reason: "footer was not painted with the first prompt",
        },
        {
          passes: hasPaintedLayout(frame.spinner),
          reason: "working spinner was not painted with the first prompt",
        },
        {
          passes: hasPaintedLayout(frame.composer) && frame.composer.value === "",
          reason: "composer was not painted and empty with the first prompt",
        },
        {
          passes: !frame.agentTab.mounted || hasPaintedLayout(frame.tabProgress),
          reason: "created agent tab appeared without running state",
        },
        {
          passes: !frame.agentTab.mounted || hasPaintedLayout(frame.interruptControl),
          reason: "created agent appeared without its interrupt control",
        },
      ]),
    );
  }
  const failure = violations[0]?.frame ?? Math.max(first, 0);
  expect(
    violations,
    `transition violations:\n${violations.map(({ frame, reason }) => `frame ${frame}: ${reason}`).join("\n")}\n\nframe record:\n${formatFrames(frames, failure)}`,
  ).toEqual([]);
}

async function recordDelayedRunningTransition(
  page: Page,
  agent: MockAgentWorkspace,
  releaseOrder: RunningReleaseOrder,
): Promise<{ frames: TurnFrame[]; checkpoints: ActivityCheckpoint[] }> {
  const gate = await installDaemonWebSocketGate(page);
  await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.agentId });
  await expectAgentIdle(page);
  await expect(page.getByRole("button", { name: "Copy turn" })).toHaveCount(1);

  const prompt = "Second prompt keeps streaming.";
  gate.holdNextAgentStreamEvent("turn_started");
  gate.holdNextAgentUpdate(agent.agentId, "running");
  gate.holdNextServerMessage("send_agent_message_response");
  gate.setAgentStreamItemSuppressed("assistant_message", true);
  await recordTurnFrames(page, prompt);
  await installActivityContinuityOracle(page, prompt);
  await submitMessage(page, prompt);
  await Promise.all([
    gate.waitForHeldAgentStreamEvent("turn_started"),
    gate.waitForHeldAgentUpdate(agent.agentId, "running"),
    gate.waitForHeldServerMessage("send_agent_message_response"),
  ]);

  let turnReleased = false;
  let snapshotReleased = false;
  let responseReleased = false;
  try {
    await expect(page.getByTestId("user-message").filter({ hasText: prompt })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toHaveValue("");
    await gate.waitForAgentStreamItem("user_message");
    await waitForActivityOracleArmed(page);
    const elapsedBeforeAuthoritative = await page.getByTestId("turn-working-elapsed").count();

    if (releaseOrder === "turn-before-response") {
      gate.releaseHeldAgentStreamEvent("turn_started");
      turnReleased = true;
      await expect(page.getByTestId("turn-working-elapsed")).toBeVisible();
      gate.releaseHeldServerMessage("send_agent_message_response");
      responseReleased = true;
      gate.releaseHeldAgentUpdate(agent.agentId, "running");
      snapshotReleased = true;
    } else if (releaseOrder === "response-before-turn") {
      gate.releaseHeldServerMessage("send_agent_message_response");
      responseReleased = true;
      await recordPaintsFor(page, 80);
      gate.releaseHeldAgentStreamEvent("turn_started");
      turnReleased = true;
      await expect(page.getByTestId("turn-working-elapsed")).toBeVisible();
      gate.releaseHeldAgentUpdate(agent.agentId, "running");
      snapshotReleased = true;
    } else {
      gate.releaseHeldServerMessage("send_agent_message_response");
      responseReleased = true;
      await recordPaintsFor(page, 80);
      gate.releaseHeldAgentUpdate(agent.agentId, "running");
      snapshotReleased = true;
      await expect(page.getByTestId("turn-working-elapsed")).toBeVisible();
      gate.releaseHeldAgentStreamEvent("turn_started");
      turnReleased = true;
    }

    await waitForRecordedFrames(page, "turn-running", 3);
    const frames = await stopTurnFrameRecording(page);
    const checkpoints = await readActivityContinuityOracle(page);
    expectActivityContinuity(checkpoints);
    expect(elapsedBeforeAuthoritative).toBe(0);
    gate.setAgentStreamItemSuppressed("assistant_message", false);
    return { frames, checkpoints };
  } finally {
    if (!turnReleased) gate.releaseHeldAgentStreamEvent("turn_started");
    if (!snapshotReleased) gate.releaseHeldAgentUpdate(agent.agentId, "running");
    if (!responseReleased) gate.releaseHeldServerMessage("send_agent_message_response");
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
    await attachImageFromMenu(page, FIRST_PROMPT_IMAGE);
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await recordTurnFrames(page, prompt);
    await submitMessage(page, prompt);

    const submittedRow = page.getByTestId("user-message").filter({ hasText: prompt }).first();
    await expect(submittedRow).toBeVisible();
    await gate.waitForServerMessage("fetch_agent_timeline_response");
    await recordPaintsFor(page, 80);
    expectAtomicFirstPromptTransition(await stopTurnFrameRecording(page));
  } finally {
    await workspace.cleanup();
  }
});

test("keeps follow-up activity continuous when turn starts before response", async ({
  page,
  streamingAgent,
}) => {
  const { frames } = await recordDelayedRunningTransition(
    page,
    streamingAgent,
    "turn-before-response",
  );
  expectAtomicIdleToRunningTransition(frames);
});

test("keeps a submitted message height stable when its canonical echo arrives", async ({
  page,
  streamingAgent,
}) => {
  const gate = await installDaemonWebSocketGate(page);
  await openAgentRoute(page, {
    workspaceId: streamingAgent.workspaceId,
    agentId: streamingAgent.agentId,
  });
  await expectAgentIdle(page);

  const prompt = "Canonical echo must not resize this message.";
  gate.holdNextAgentStreamItem("user_message");
  await recordTurnFrames(page, prompt);
  await submitMessage(page, prompt);
  await gate.waitForHeldAgentStreamItem("user_message");
  const submittedRow = page.getByTestId("user-message").filter({ hasText: prompt });
  await expect(submittedRow).toBeVisible();
  await recordPaintsFor(page, 80);

  gate.releaseHeldAgentStreamItem("user_message");
  await expect(submittedRow.getByTestId("rewind-menu-trigger")).toBeVisible();
  await recordPaintsFor(page, 80);

  expectSubmittedMessageHeightStable(await stopTurnFrameRecording(page));
});

test("keeps follow-up activity continuous when response arrives before running state", async ({
  page,
  streamingAgent,
}) => {
  const { frames } = await recordDelayedRunningTransition(
    page,
    streamingAgent,
    "response-before-turn",
  );
  expectAtomicIdleToRunningTransition(frames);
});

test("keeps follow-up activity continuous when snapshot opens before turn event", async ({
  page,
  streamingAgent,
}) => {
  const { frames } = await recordDelayedRunningTransition(
    page,
    streamingAgent,
    "snapshot-before-turn",
  );
  expectAtomicIdleToRunningTransition(frames);
});
