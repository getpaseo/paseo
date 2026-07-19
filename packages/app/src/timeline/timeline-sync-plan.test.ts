import { describe, expect, test } from "vitest";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import {
  isTimelineCatchUpComplete,
  planInitialAgentTimelineSync,
  planResumeTimelineSync,
  planTimelineOlderFetch,
} from "./timeline-sync-plan";

describe("timeline sync planning", () => {
  test("initial open without an authoritative cursor loads a bounded tail page", () => {
    const plan = planInitialAgentTimelineSync({
      cursor: undefined,
      hasAuthoritativeHistory: false,
    });

    expect(plan).toEqual({
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
    });
  });

  test("initial open with an authoritative cursor catches up after the cursor", () => {
    const plan = planInitialAgentTimelineSync({
      cursor: { epoch: "epoch-1", startSeq: 1, endSeq: 42 },
      hasAuthoritativeHistory: true,
    });

    expect(plan).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 42 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
    });
  });

  test("resume with a cursor catches up after the cursor", () => {
    const plan = planResumeTimelineSync({
      cursor: { epoch: "epoch-1", startSeq: 1, endSeq: 100 },
    });

    expect(plan).toEqual({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
    });
  });

  test("resume without a cursor loads a bounded tail page", () => {
    const plan = planResumeTimelineSync({ cursor: undefined });

    expect(plan).toEqual({
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
    });
  });

  test("older history loads one bounded page before the start cursor", () => {
    const plan = planTimelineOlderFetch({ epoch: "epoch-1", seq: 25 });

    expect(plan).toEqual({
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 25 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
    });
  });

  test("catch-up finishes when the daemon reports no newer rows", () => {
    expect(isTimelineCatchUpComplete({ direction: "after", hasNewer: false, error: null })).toBe(
      true,
    );
  });
});
