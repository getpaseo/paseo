import { describe, expect, it } from "vitest";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { __private__ } from "./use-agent-initialization";

describe("useAgentInitialization timeline request policy", () => {
  it("uses canonical tail bootstrap when history has not synced yet", () => {
    expect(
      __private__.deriveInitialTimelineRequest({
        cursor: {
          epoch: "epoch-1",
          seq: 42,
        },
        hasAuthoritativeHistory: false,
      }),
    ).toEqual({
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  });

  it("uses canonical tail bootstrap when cursor is missing", () => {
    expect(
      __private__.deriveInitialTimelineRequest({
        cursor: null,
        hasAuthoritativeHistory: true,
      }),
    ).toEqual({
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  });

  it("uses canonical catch-up after the current cursor once history is synced", () => {
    expect(
      __private__.deriveInitialTimelineRequest({
        cursor: {
          epoch: "epoch-1",
          seq: 42,
        },
        hasAuthoritativeHistory: true,
      }),
    ).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 42 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  });

  it("does not expose an RPC-success init fallback", () => {
    expect("shouldResolveInitFromRpcSuccess" in __private__).toBe(false);
  });
});
