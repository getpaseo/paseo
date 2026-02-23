import { describe, expect, it } from "vitest";
import { __private__ } from "./use-agent-initialization";

describe("useAgentInitialization timeline request policy", () => {
  it("uses canonical tail bootstrap when cursor is missing", () => {
    expect(__private__.buildInitialTimelineRequest(undefined)).toEqual({
      direction: "tail",
      limit: 200,
      projection: "canonical",
    });
  });

  it("uses canonical catch-up after the current cursor when present", () => {
    expect(
      __private__.buildInitialTimelineRequest({
        epoch: "epoch-1",
        endSeq: 42,
      })
    ).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 42 },
      limit: 0,
      projection: "canonical",
    });
  });
});
