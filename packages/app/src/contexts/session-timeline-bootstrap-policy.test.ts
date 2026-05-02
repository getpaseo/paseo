import { describe, expect, it } from "vitest";
import { deriveInitialTimelineRequest } from "./session-timeline-bootstrap-policy";

describe("deriveInitialTimelineRequest", () => {
  it("requests tail history when authoritative history has not been applied", () => {
    expect(
      deriveInitialTimelineRequest({
        cursor: { epoch: "epoch-1", seq: 42 },
        hasAuthoritativeHistory: false,
        initialTimelineLimit: 100,
      }),
    ).toEqual({
      direction: "tail",
      limit: 100,
      projection: "canonical",
    });
  });

  it("requests tail history when no cursor is available", () => {
    expect(
      deriveInitialTimelineRequest({
        cursor: null,
        hasAuthoritativeHistory: true,
        initialTimelineLimit: 100,
      }),
    ).toEqual({
      direction: "tail",
      limit: 100,
      projection: "canonical",
    });
  });

  it("requests only entries after the known cursor when authoritative history exists", () => {
    expect(
      deriveInitialTimelineRequest({
        cursor: { epoch: "epoch-1", seq: 42 },
        hasAuthoritativeHistory: true,
        initialTimelineLimit: 100,
      }),
    ).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 42 },
      limit: 0,
      projection: "canonical",
    });
  });
});
