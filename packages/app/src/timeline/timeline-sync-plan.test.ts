import { describe, expect, test } from "vitest";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import {
  isTimelineCatchUpComplete,
  planTimelineOlderFetch,
  planTimelineTailFetch,
} from "./timeline-sync-plan";

describe("timeline sync planning", () => {
  test("agent synchronization checks a bounded tail page", () => {
    const plan = planTimelineTailFetch();

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
