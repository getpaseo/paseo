import { describe, expect, it } from "vitest";
import { PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";
import {
  createNativePromptJumpSession,
  NATIVE_PROMPT_JUMP_SAMPLE_BUDGET,
  NATIVE_PROMPT_JUMP_TOLERANCE_PX,
  resolveNativePromptJumpOffset,
  resolveMeasuredWindowRevealPosition,
  stepNativePromptJump,
  type NativePromptJumpMeasurement,
} from "./prompt-jump-native";

const measured: NativePromptJumpMeasurement = {
  frame: { y: 700, height: 300 },
  offsetY: 0,
  viewportHeight: 500,
  contentHeight: 5_000,
  topInset: 20,
  sampled: 0,
  stable: 0,
};

describe.each([5, 10])("resolveMeasuredWindowRevealPosition with windowSize %i", (windowSize) => {
  const viewportHeight = 736;
  // Half of (windowSize - 1) viewports past the screen, plus the screen itself.
  const limit = viewportHeight * (1 + (windowSize - 1) / 2);

  it("fills the viewport when the measured row is shorter than the overscan", () => {
    expect(
      resolveMeasuredWindowRevealPosition({ frameHeight: 102, viewportHeight, windowSize }),
    ).toBe(0);
  });

  it("pins the far edge when the measured row hides everything after it", () => {
    expect(
      resolveMeasuredWindowRevealPosition({ frameHeight: 17_240, viewportHeight, windowSize }),
    ).toBe(1);
  });

  it("treats a row that still ends inside the overscan as short", () => {
    expect(
      resolveMeasuredWindowRevealPosition({ frameHeight: limit, viewportHeight, windowSize }),
    ).toBe(0);
    expect(
      resolveMeasuredWindowRevealPosition({
        frameHeight: limit + 1,
        viewportHeight,
        windowSize,
      }),
    ).toBe(1);
  });

  it("pins the far edge when the row has not reported a height", () => {
    expect(
      resolveMeasuredWindowRevealPosition({ frameHeight: 0, viewportHeight, windowSize }),
    ).toBe(1);
  });
});

describe("resolveNativePromptJumpOffset", () => {
  it("places the row's top edge just below the header", () => {
    // viewPosition 0: cellOffset - topInset - 8
    expect(
      resolveNativePromptJumpOffset({
        frameY: 700,
        frameHeight: 300,
        viewportHeight: 500,
        topInset: 20,
      }),
    ).toBe(700 - 20 - PROMPT_JUMP_TOP_INSET_PX);
  });

  it("never scrolls past the start of the list", () => {
    expect(
      resolveNativePromptJumpOffset({
        frameY: 4,
        frameHeight: 80,
        viewportHeight: 500,
        topInset: 0,
      }),
    ).toBe(0);
  });
});

describe("stepNativePromptJump", () => {
  it("corrects to the measured landing offset", () => {
    expect(stepNativePromptJump(measured)).toEqual({
      kind: "correct",
      offset: 672,
      sampled: 1,
      stable: 0,
    });
  });

  it("holds once the row is within tolerance, then settles on the next quiet sample", () => {
    const landed = { ...measured, offsetY: 672 };
    expect(stepNativePromptJump(landed)).toEqual({ kind: "hold", sampled: 1, stable: 1 });
    expect(stepNativePromptJump({ ...landed, sampled: 1, stable: 1 })).toEqual({
      kind: "settled",
    });
  });

  it("treats a few points of error as landed", () => {
    const within = {
      ...measured,
      offsetY: 672 + NATIVE_PROMPT_JUMP_TOLERANCE_PX,
    };
    expect(stepNativePromptJump(within)).toMatchObject({ kind: "hold", stable: 1 });
    const outside = {
      ...measured,
      offsetY: 672 + NATIVE_PROMPT_JUMP_TOLERANCE_PX + 1,
    };
    expect(stepNativePromptJump(outside)).toMatchObject({
      kind: "correct",
      offset: 672,
      stable: 0,
    });
  });

  it("corrects again when a remeasure moves the row", () => {
    const first = stepNativePromptJump(measured);
    expect(first).toMatchObject({ kind: "correct", offset: 672 });
    const grown = stepNativePromptJump({
      ...measured,
      frame: { y: 900, height: 480 },
      offsetY: 672,
      sampled: 1,
      stable: 1,
    });
    expect(grown).toEqual({ kind: "correct", offset: 872, sampled: 2, stable: 0 });
  });

  it("does not spend a sample while the row or the viewport is unmeasured", () => {
    expect(stepNativePromptJump({ ...measured, frame: null })).toEqual({ kind: "unmeasured" });
    expect(stepNativePromptJump({ ...measured, frame: { y: 10, height: 0 } })).toEqual({
      kind: "unmeasured",
    });
    expect(stepNativePromptJump({ ...measured, viewportHeight: 0 })).toEqual({
      kind: "unmeasured",
    });
    expect(stepNativePromptJump({ ...measured, contentHeight: 0 })).toEqual({
      kind: "unmeasured",
    });
  });

  it("waits instead of clamping when the content is shorter than the row", () => {
    const step = stepNativePromptJump({
      ...measured,
      frame: { y: 4_700, height: 300 },
      contentHeight: 5_000,
      offsetY: 4_500,
    });
    expect(step).toEqual({ kind: "hold", sampled: 1, stable: 0 });
  });

  it("stops after the sample budget even if the row is still short", () => {
    expect(
      stepNativePromptJump({ ...measured, sampled: NATIVE_PROMPT_JUMP_SAMPLE_BUDGET }),
    ).toEqual({ kind: "stopped" });
  });
});

describe("native prompt jump ownership", () => {
  function createSession() {
    const scheduled: (() => void)[] = [];
    const cancelled: number[] = [];
    const events: string[] = [];
    const session = createNativePromptJumpSession({
      schedule(callback) {
        const id = scheduled.length;
        scheduled.push(callback);
        return () => {
          cancelled.push(id);
        };
      },
      setBatchActive(active) {
        events.push(`batch:${active}`);
      },
      requestBottomAnchor(request) {
        events.push(request.reason);
      },
    });
    return { session, scheduled, cancelled, events };
  }

  it("ends the jump before requesting the bottom anchor so a queued timer cannot undo navigation", () => {
    const h = createSession();
    h.session.begin("older");
    h.session.schedule(() => {
      h.events.push("scroll:older");
    });
    h.session.requestBottomAnchor({ agentId: "agent-1", reason: "jump-to-bottom" });
    h.scheduled[0]!();
    expect(h.events).toEqual(["batch:true", "batch:false", "jump-to-bottom"]);
    expect(h.cancelled).toEqual([0]);
    expect(h.session.getCurrent()).toBeNull();
  });

  it("cancels the landing loop and restores ordinary batches when a drag takes ownership", () => {
    const h = createSession();
    h.session.begin("older");
    h.session.schedule(() => {
      h.events.push("scroll:older");
    });
    h.session.end();
    h.scheduled[0]!();
    expect(h.events).toEqual(["batch:true", "batch:false"]);
    expect(h.cancelled).toEqual([0]);
  });

  it("reinitializes a new agent's jump without accepting a previous timer or sample counters", () => {
    const h = createSession();
    h.session.begin("agent-1-prompt");
    h.session.schedule(() => {
      h.events.push("scroll:agent-1");
    });
    h.session.end();
    h.session.begin("agent-2-prompt");
    h.session.schedule(() => {
      h.events.push("scroll:agent-2");
    });
    h.scheduled[0]!();
    h.scheduled[1]!();
    expect(h.events).toEqual(["batch:true", "batch:false", "batch:true", "scroll:agent-2"]);
    expect(h.session.getCurrent()).toEqual({
      messageId: "agent-2-prompt",
      sampled: 0,
      stable: 0,
      approachSteps: 0,
    });
  });

  it("cancels on unmount without requesting a React batch update", () => {
    const h = createSession();
    h.session.begin("older");
    h.session.schedule(() => {
      h.events.push("scroll:older");
    });
    h.session.cancel();
    h.scheduled[0]!();
    expect(h.events).toEqual(["batch:true"]);
    expect(h.cancelled).toEqual([0]);
  });
});
