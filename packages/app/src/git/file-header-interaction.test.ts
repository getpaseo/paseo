import { describe, expect, it } from "vitest";
import {
  reduceFileHeaderPress,
  shouldActivateStickyHeaderPress,
  type FileHeaderPressEvent,
  type FileHeaderPressPhase,
} from "./file-header-interaction";

const pressOrigin = { startedAt: 1_000, pageX: 20, pageY: 30 };

describe("file header interaction arbitration", () => {
  it("activates an unhandled native sticky-header tap on press out", () => {
    expect(
      shouldActivateStickyHeaderPress({
        enabled: true,
        native: true,
        pressHandled: false,
        stickyPressFallback: true,
        pressOrigin,
        releasedAt: 1_500,
        pageX: 32,
        pageY: 30,
      }),
    ).toBe(true);
  });

  it.each([
    ["an already handled long press", { pressHandled: true }],
    ["a non-native release", { native: false }],
    ["a non-sticky header", { stickyPressFallback: false }],
    ["a held press", { releasedAt: 1_501 }],
    ["a moved press", { pageX: 33 }],
  ])("does not activate %s", (_label, override) => {
    expect(
      shouldActivateStickyHeaderPress({
        enabled: true,
        native: true,
        pressHandled: false,
        stickyPressFallback: true,
        pressOrigin,
        releasedAt: 1_500,
        pageX: 32,
        pageY: 30,
        ...override,
      }),
    ).toBe(false);
  });

  function run(events: FileHeaderPressEvent[]) {
    let phase: FileHeaderPressPhase = "idle";
    const effects: string[] = [];
    for (const event of events) {
      const next = reduceFileHeaderPress(phase, event);
      phase = next.phase;
      if (next.effect !== "none") effects.push(next.effect);
    }
    return effects;
  }

  it("lets a normal press claim a deferred sticky release exactly once", () => {
    expect(
      run([
        { type: "press-in" },
        { type: "press-out", stickyFallbackEligible: true },
        { type: "press" },
        { type: "fallback" },
      ]),
    ).toEqual(["defer-activate", "activate"]);
  });

  it("keeps a duplicated wrapper press-out eligible for one fallback", () => {
    expect(
      run([
        { type: "press-in" },
        { type: "press-out", stickyFallbackEligible: true },
        { type: "press-out", stickyFallbackEligible: true },
        { type: "fallback" },
      ]),
    ).toEqual(["defer-activate", "activate"]);
  });

  it("falls back once for a canceled sticky press", () => {
    expect(
      run([
        { type: "press-in" },
        { type: "press-out", stickyFallbackEligible: true },
        { type: "fallback" },
      ]),
    ).toEqual(["defer-activate", "activate"]);
  });

  it.each([
    [
      "canceled non-sticky",
      [{ type: "press-in" }, { type: "press-out", stickyFallbackEligible: false }],
    ],
    [
      "moved",
      [
        { type: "press-in" },
        { type: "press-out", stickyFallbackEligible: false },
        { type: "fallback" },
      ],
    ],
  ] as const)("does not activate a %s sequence", (_label, events) => {
    expect(run([...events])).toEqual([]);
  });

  it("selects a long press without activating when Pressability later emits press-out/press", () => {
    expect(
      run([
        { type: "press-in" },
        { type: "long-press" },
        { type: "press-out", stickyFallbackEligible: false },
        { type: "press" },
        { type: "fallback" },
      ]),
    ).toEqual(["select"]);
  });
});
