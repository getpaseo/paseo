import { describe, expect, it } from "vitest";
import { __private__ } from "./use-agent-initialization";

describe("useAgentInitialization timeline request policy", () => {
  it("uses canonical tail bootstrap when cursor is missing", () => {
    expect(
      __private__.buildInitialTimelineRequest({
        cursor: undefined,
        hasLocalTail: false,
        initialTimelineLimit: 200,
      })
    ).toEqual({
      direction: "tail",
      limit: 200,
      projection: "canonical",
    });
  });

  it("uses canonical tail bootstrap when cursor exists but local tail is empty", () => {
    expect(
      __private__.buildInitialTimelineRequest({
        cursor: {
          epoch: "epoch-1",
          endSeq: 42,
        },
        hasLocalTail: false,
        initialTimelineLimit: 200,
      })
    ).toEqual({
      direction: "tail",
      limit: 200,
      projection: "canonical",
    });
  });

  it("uses canonical catch-up after the current cursor when local tail exists", () => {
    expect(
      __private__.buildInitialTimelineRequest({
        cursor: {
          epoch: "epoch-1",
          endSeq: 42,
        },
        hasLocalTail: true,
        initialTimelineLimit: 200,
      })
    ).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 42 },
      limit: 0,
      projection: "canonical",
    });
  });

  it("supports unbounded tail bootstrap policy", () => {
    expect(
      __private__.buildInitialTimelineRequest({
        cursor: undefined,
        hasLocalTail: false,
        initialTimelineLimit: 0,
      })
    ).toEqual({
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
  });
});
