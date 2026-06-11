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

  it("nests threads under the review they were submitted with", () => {
    const review = activity({
      id: "R1",
      kind: "review",
      reviewState: "changes_requested",
      body: "Please fix these.",
    });
    const thread = activity({
      id: "t1",
      reviewId: "R1",
      location: { path: "src/a.ts", line: 4, threadId: "T1" },
    });
    const reply = activity({
      id: "t1-reply",
      reviewId: "R2-later",
      location: { path: "src/a.ts", line: 4, threadId: "T1" },
    });
    const unrelated = activity({
      id: "t2",
      reviewId: "R-unknown",
      location: { path: "src/b.ts", threadId: "T2" },
    });

    expect(buildPrTimeline([review, thread, reply, unrelated])).toEqual([
      {
        kind: "review",
        id: "R1",
        review,
        threads: [
          {
            kind: "thread",
            id: "thread:T1",
            location: { path: "src/a.ts", line: 4, threadId: "T1" },
            comments: [thread, reply],
          },
        ],
      },
      {
        kind: "thread",
        id: "thread:T2",
        location: { path: "src/b.ts", threadId: "T2" },
        comments: [unrelated],
      },
    ]);
  });

  it("keeps reviews without threads as single entries", () => {
    const review = activity({ id: "R1", kind: "review", reviewState: "approved" });

    expect(buildPrTimeline([review])).toEqual([{ kind: "single", id: "R1", activity: review }]);
  });
});
