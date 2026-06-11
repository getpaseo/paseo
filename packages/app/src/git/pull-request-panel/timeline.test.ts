import { describe, expect, it } from "vitest";
import { buildPrTimeline } from "./timeline";
import type { PrPaneActivity } from "./data";

function activity(overrides: Partial<PrPaneActivity> & { id: string }): PrPaneActivity {
  return {
    provider: "github",
    kind: "comment",
    author: "alice",
    avatarColor: "#8b5cf6",
    body: "body",
    age: "1h ago",
    url: "https://github.com/acme/app/pull/1#comment",
    ...overrides,
  };
}

describe("buildPrTimeline", () => {
  it("keeps standalone comments and reviews as single entries in order", () => {
    const comment = activity({ id: "c1" });
    const review = activity({ id: "r1", kind: "review", reviewState: "approved" });

    expect(buildPrTimeline([comment, review])).toEqual([
      { kind: "single", id: "c1", activity: comment },
      { kind: "single", id: "r1", activity: review },
    ]);
  });

  it("groups comments sharing a threadId into one thread at the first comment's position", () => {
    const before = activity({ id: "c1" });
    const root = activity({
      id: "t1-root",
      location: { path: "src/a.ts", line: 12, threadId: "PRRT_1", isResolved: false },
    });
    const between = activity({ id: "c2" });
    const reply = activity({
      id: "t1-reply",
      author: "bob",
      location: { path: "src/a.ts", line: 12, threadId: "PRRT_1", isResolved: false },
    });

    expect(buildPrTimeline([before, root, between, reply])).toEqual([
      { kind: "single", id: "c1", activity: before },
      {
        kind: "thread",
        id: "thread:PRRT_1",
        location: { path: "src/a.ts", line: 12, threadId: "PRRT_1", isResolved: false },
        comments: [root, reply],
      },
      { kind: "single", id: "c2", activity: between },
    ]);
  });

  it("keeps located comments without a threadId as single entries", () => {
    const located = activity({ id: "c1", location: { path: "src/a.ts", line: 3 } });

    expect(buildPrTimeline([located])).toEqual([{ kind: "single", id: "c1", activity: located }]);
  });

  it("separates distinct threads", () => {
    const a = activity({ id: "a", location: { path: "x.ts", threadId: "T1" } });
    const b = activity({ id: "b", location: { path: "y.ts", threadId: "T2" } });
    const a2 = activity({ id: "a2", location: { path: "x.ts", threadId: "T1" } });

    const entries = buildPrTimeline([a, b, a2]);
    expect(entries.map((entry) => entry.id)).toEqual(["thread:T1", "thread:T2"]);
    expect(entries[0]).toMatchObject({ comments: [a, a2] });
    expect(entries[1]).toMatchObject({ comments: [b] });
  });
});
