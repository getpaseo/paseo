import { describe, expect, it } from "vitest";
import {
  reduceFileHeaderPress,
  type FileHeaderPressEvent,
  type FileHeaderPressPhase,
} from "./file-header-interaction";

describe("file header interaction arbitration", () => {
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

  it("activates an actual press", () => {
    expect(run([{ type: "press-in" }, { type: "press" }])).toEqual(["activate"]);
  });

  it("does not activate when scrolling cancels the press", () => {
    expect(run([{ type: "press-in" }])).toEqual([]);
  });

  it("selects a long press without activating when Pressability later emits press", () => {
    expect(run([{ type: "press-in" }, { type: "long-press" }, { type: "press" }])).toEqual([
      "select",
    ]);
  });
});
