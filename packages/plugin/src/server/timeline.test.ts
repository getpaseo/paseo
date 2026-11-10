import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { latestTurn } from "./timeline.js";

type Refetch = PaseoAgentTimelineHandle["refetch"];

function user(text: string): AgentTimelineItem {
  return { type: "user_message", text };
}
function reply(text: string): AgentTimelineItem {
  return { type: "assistant_message", text };
}

/** Serves `history` in pages of `size`, newest page first, like the daemon's tail/before cursors. */
function pagedTimeline(history: AgentTimelineItem[], size: number) {
  const requests: string[] = [];
  const refetch = (async (options) => {
    const end = options?.direction === "before" ? Number(options.cursor) : history.length;
    const start = Math.max(0, end - size);
    requests.push(`${options?.direction}:${end}`);
    return {
      entries: history.slice(start, end).map((item) => ({ item })),
      hasOlder: start > 0,
      startCursor: start > 0 ? String(start) : null,
    };
  }) as Refetch;
  return { refetch, requests };
}

describe("latestTurn", () => {
  it("returns the last user message and what followed it", async () => {
    const source = pagedTimeline(
      [user("one"), reply("first"), user("two"), reply("a"), reply("b")],
      50,
    );
    expect(await latestTurn(source)).toEqual([user("two"), reply("a"), reply("b")]);
  });

  it("pages back until it reaches the user message", async () => {
    const history = [user("go"), ...Array.from({ length: 120 }, (_, i) => reply(String(i)))];
    const source = pagedTimeline(history, 50);
    const turn = await latestTurn(source);
    expect(turn).toHaveLength(121);
    expect(turn[0]).toEqual(user("go"));
    expect(source.requests).toEqual(["tail:121", "before:71", "before:21"]);
  });

  it("returns the whole history when there is no user message", async () => {
    const source = pagedTimeline([reply("hello")], 50);
    expect(await latestTurn(source)).toEqual([reply("hello")]);
  });
});
