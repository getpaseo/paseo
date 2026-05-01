import { describe, expect, it } from "vitest";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { deriveInitialTimelineRequest } from "./session-timeline-bootstrap-policy";

describe("deriveInitialTimelineRequest", () => {
  it("requests tail history when authoritative history has not been applied", () => {
    expect(
      deriveInitialTimelineRequest({
        cursor: { epoch: "epoch-1", seq: 42 },
        hasAuthoritativeHistory: false,
      }),
    ).toEqual({
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  });

  it("requests tail history when no cursor is available", () => {
    expect(
      deriveInitialTimelineRequest({
        cursor: null,
        hasAuthoritativeHistory: true,
      }),
    ).toEqual({
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  });

  it("requests only entries after the known cursor when authoritative history exists", () => {
    expect(
      deriveInitialTimelineRequest({
        cursor: { epoch: "epoch-1", seq: 42 },
        hasAuthoritativeHistory: true,
      }),
    ).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 42 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  });
});
