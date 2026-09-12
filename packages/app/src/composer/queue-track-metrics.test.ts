import { describe, expect, it } from "vitest";

import {
  QUEUE_ACTION_BUTTON_SIZE,
  QUEUE_VISIBLE_ITEMS,
  queueTrackMaxHeight,
} from "./queue-track-metrics.js";

describe("queueTrackMaxHeight", () => {
  it("fits exactly the visible rows and the gaps between them", () => {
    // 5 rows of (32 + 8*2 + 1*2) plus 4 gaps of 8.
    expect(queueTrackMaxHeight({ spacing: 8, borderWidth: 1 })).toBe(282);
  });

  it("counts one fewer gap than rows", () => {
    const single = queueTrackMaxHeight({ spacing: 8, borderWidth: 1, visibleItems: 1 });
    const double = queueTrackMaxHeight({ spacing: 8, borderWidth: 1, visibleItems: 2 });
    const rowHeight = QUEUE_ACTION_BUTTON_SIZE + 8 * 2 + 1 * 2;
    expect(single).toBe(rowHeight);
    expect(double).toBe(rowHeight * 2 + 8);
  });

  it("tracks the row box so the visible count cannot drift", () => {
    const base = queueTrackMaxHeight({ spacing: 8, borderWidth: 1 });
    expect(queueTrackMaxHeight({ spacing: 12, borderWidth: 1 })).toBeGreaterThan(base);
    expect(queueTrackMaxHeight({ spacing: 8, borderWidth: 2 })).toBeGreaterThan(base);
  });

  it("caps a queue longer than the visible count", () => {
    const cap = queueTrackMaxHeight({ spacing: 8, borderWidth: 1 });
    const twentyRows = queueTrackMaxHeight({ spacing: 8, borderWidth: 1, visibleItems: 20 });
    expect(cap).toBeLessThan(twentyRows);
    expect(QUEUE_VISIBLE_ITEMS).toBeLessThan(20);
  });

  it("collapses rather than returning a negative height", () => {
    expect(queueTrackMaxHeight({ spacing: 8, borderWidth: 1, visibleItems: 0 })).toBe(0);
  });
});
