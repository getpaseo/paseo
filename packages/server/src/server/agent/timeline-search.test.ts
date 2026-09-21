import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { describe, it, expect } from "vitest";
import { searchTimeline } from "./timeline-search.js";

describe("searchTimeline", () => {
  it("finds matches in user and assistant messages", () => {
    const rows: AgentTimelineRow[] = [
      {
        seq: 1,
        timestamp: "2026-09-21T00:00:00Z",
        item: { type: "user_message", text: "Hello world" },
      },
      {
        seq: 2,
        timestamp: "2026-09-21T00:01:00Z",
        item: { type: "assistant_message", text: "Hello back, testing world search" },
      },
    ];

    const result = searchTimeline(rows, "world");
    expect(result.matches).toHaveLength(2);
    expect(result.matches[1].kind).toBe("user");
    expect(result.matches[1].occurrences[0].startOffset).toBe(6);
    expect(result.matches[0].kind).toBe("assistant");
    expect(result.matches[0].occurrences[0].startOffset).toBe(20);
  });
});
