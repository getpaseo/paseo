import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type {
  DaemonClient,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import {
  createFollowJsonWriter,
  createFollowTranscriptWriter,
  formatAgentActivityTranscript,
  fetchOneShotTimelineItems,
} from "./logs.js";

function page(seq: number, hasOlder: boolean): FetchAgentTimelinePayload {
  return {
    requestId: "request",
    agentId: "agent",
    agent: null,
    direction: "tail",
    projection: "projected",
    epoch: "epoch",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: 4, nextSeq: 5 },
    startCursor: { epoch: "epoch", seq },
    endCursor: { epoch: "epoch", seq },
    hasOlder,
    hasNewer: false,
    error: null,
    entries: [
      {
        provider: "codex",
        item: { type: "user_message", text: `row ${seq}` },
        timestamp: "2026-01-01T00:00:00Z",
        seqStart: seq,
        seqEnd: seq,
        sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
        collapsed: [],
      },
    ],
  };
}

describe("one-shot timeline paging", () => {
  it("retries only oversized pages at the same cursor with a smaller limit", async () => {
    const requests: Array<Parameters<DaemonClient["fetchAgentTimeline"]>[1]> = [];
    const client = {
      async fetchAgentTimeline(
        _agentId: string,
        options?: Parameters<DaemonClient["fetchAgentTimeline"]>[1],
      ) {
        requests.push(options);
        if (requests.length === 1) return page(3, true);
        if (requests.length === 2) throw new Error("Logical message too large");
        return page(1, false);
      },
    };
    expect(await fetchOneShotTimelineItems(client, "agent", undefined, undefined)).toEqual([
      { type: "user_message", text: "row 1" },
      { type: "user_message", text: "row 3" },
    ]);
    expect(
      requests.map((request) => [request?.direction, request?.limit, request?.cursor]),
    ).toEqual([
      ["tail", 200, undefined],
      ["before", 200, { epoch: "epoch", seq: 3 }],
      ["before", 100, { epoch: "epoch", seq: 3 }],
    ]);
  });

  it("fails promptly if a single-row page is still oversized", async () => {
    let calls = 0;
    const client = {
      async fetchAgentTimeline() {
        calls++;
        throw new Error("Logical message too large");
      },
    };
    await expect(fetchOneShotTimelineItems(client, "agent", undefined, 1)).rejects.toThrow(
      "even at limit 1",
    );
    expect(calls).toBe(1);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    const client = {
      async fetchAgentTimeline() {
        calls++;
        throw new Error("disconnected");
      },
    };
    await expect(fetchOneShotTimelineItems(client, "agent", undefined, undefined)).rejects.toThrow(
      "disconnected",
    );
    expect(calls).toBe(1);
  });
  it.each([
    ["zero", { ...page(2, true), startCursor: { epoch: "epoch", seq: 0 } }],
    [
      "unsafe",
      { ...page(2, true), startCursor: { epoch: "epoch", seq: Number.MAX_SAFE_INTEGER + 1 } },
    ],
    ["wrong epoch", { ...page(2, true), startCursor: { epoch: "other", seq: 2 } }],
    ["past first row", { ...page(2, true), startCursor: { epoch: "epoch", seq: 3 } }],
    ["missing", { ...page(2, true), startCursor: null }],
    ["reset", { ...page(2, true), reset: true }],
    ["stale", { ...page(2, true), staleCursor: true }],
    ["gap", { ...page(2, true), gap: true }],
  ])("rejects %s on the first page", async (_name, response) => {
    const client = { fetchAgentTimeline: async () => response };
    await expect(
      fetchOneShotTimelineItems(client, "agent", undefined, undefined),
    ).rejects.toThrow();
  });

  it("rejects a repeated cursor and an epoch change", async () => {
    for (const next of [page(2, true), { ...page(1, false), epoch: "other" }]) {
      const pages = [page(2, true), next];
      const client = { fetchAgentTimeline: async () => pages.shift()! };
      await expect(
        fetchOneShotTimelineItems(client, "agent", undefined, undefined),
      ).rejects.toThrow();
    }
  });

  it("keeps older matches when timestamps are not monotonic", async () => {
    const newer = {
      ...page(3, true),
      entries: [{ ...page(3, true).entries[0], timestamp: "2000-01-01T00:00:00Z" }],
    };
    const older = {
      ...page(1, false),
      entries: [{ ...page(1, false).entries[0], timestamp: "2100-01-01T00:00:00Z" }],
    };
    const pages = [newer, older];
    const client = { fetchAgentTimeline: async () => pages.shift()! };
    expect(
      await fetchOneShotTimelineItems(client, "agent", Date.parse("2050-01-01"), undefined),
    ).toEqual([{ type: "user_message", text: "row 1" }]);
  });
});

function collect(items: readonly AgentTimelineItem[], turnId?: string): string {
  let output = "";
  const writer = createFollowTranscriptWriter((chunk) => {
    output += chunk;
  });
  for (const item of items) {
    writer.push(item, turnId);
  }
  writer.end();
  return output;
}

describe("createFollowTranscriptWriter", () => {
  it("matches one-shot logs when reasoning and assistant text alternate", () => {
    const items: AgentTimelineItem[] = [
      { type: "reasoning", text: "Check " },
      { type: "reasoning", text: "the commands." },
      { type: "assistant_message", text: "I will list the commands.", messageId: "msg_1" },
      { type: "reasoning", text: "Then summarize." },
      { type: "assistant_message", text: "Done.", messageId: "msg_2" },
    ];

    expect(collect(items).trimEnd()).toBe(formatAgentActivityTranscript(items));
  });

  it("keeps a word that arrives split across fragments intact", () => {
    const output = collect([
      { type: "assistant_message", text: "the paseo-pr", messageId: "msg_1" },
      { type: "assistant_message", text: "-cycle label\n", messageId: "msg_1" },
    ]);

    expect(output).toBe("the paseo-pr-cycle label\n");
  });

  it("streams text as it arrives without inventing a line break", () => {
    const chunks: string[] = [];
    const writer = createFollowTranscriptWriter((chunk) => {
      chunks.push(chunk);
    });

    writer.push({
      type: "assistant_message",
      text: "first line",
      messageId: "msg_1",
    });
    expect(chunks.join("")).toBe("first line");

    writer.push({
      type: "assistant_message",
      text: "\nsecond",
      messageId: "msg_1",
    });
    expect(chunks.join("")).toBe("first line\nsecond");

    writer.push({
      type: "assistant_message",
      text: " line\n",
      messageId: "msg_1",
    });
    expect(chunks.join("")).toBe("first line\nsecond line");

    writer.end();
    expect(chunks.join("")).toBe("first line\nsecond line\n");
  });

  it("emits the same transcript the one-shot command prints for the same items", () => {
    const items: AgentTimelineItem[] = [
      {
        type: "assistant_message",
        text: "Plan for paseo-pr",
        messageId: "msg_1",
      },
      {
        type: "assistant_message",
        text: "-cycle:\n- build\n- test\n",
        messageId: "msg_1",
      },
      { type: "error", message: "boom" },
      { type: "assistant_message", text: "done", messageId: "msg_2" },
    ];

    expect(collect(items).trimEnd()).toBe(formatAgentActivityTranscript(items));
  });

  it("starts a new message when the messageId changes", () => {
    const output = collect([
      { type: "assistant_message", text: "first", messageId: "msg_1" },
      { type: "assistant_message", text: "second", messageId: "msg_2" },
    ]);

    expect(output).toBe("first\nsecond\n");
  });

  it("does not merge fragments across turns", () => {
    let output = "";
    const writer = createFollowTranscriptWriter((chunk) => {
      output += chunk;
    });

    writer.push({ type: "assistant_message", text: "first" }, "turn_1");
    writer.push({ type: "assistant_message", text: "second" }, "turn_2");
    writer.end();

    expect(output).toBe("first\nsecond\n");
  });

  it("prints the thought prefix once for a merged reasoning stream", () => {
    const output = collect([
      { type: "reasoning", text: "checking the" },
      { type: "reasoning", text: " lockfile\nthen the build\n" },
    ]);

    expect(output).toBe("[Thought] checking the lockfile\nthen the build\n");
  });

  it("keeps reasoning blocks separate across hidden timeline items", () => {
    let output = "";
    const writer = createFollowTranscriptWriter((chunk) => {
      output += chunk;
    }, "reasoning");
    writer.push({ type: "reasoning", text: "checking files" });
    writer.push({
      type: "tool_call",
      callId: "tool_1",
      name: "Bash",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: "ls", output: "files" },
    });
    writer.push({ type: "reasoning", text: "running tests" });
    writer.end();

    expect(output).toBe("[Thought] checking files\n[Thought] running tests\n");
  });

  it("keeps interior blank lines and drops trailing whitespace", () => {
    const output = collect([
      {
        type: "assistant_message",
        text: "  # Title\n\nBody\n\n  ",
        messageId: "msg_1",
      },
    ]);

    expect(output).toBe("# Title\n\nBody\n");
  });
});

describe("createFollowJsonWriter", () => {
  it("writes one JSON item per line and honours the filter", () => {
    let output = "";
    const writer = createFollowJsonWriter("tools", (chunk) => {
      output += chunk;
    });
    const toolCall = {
      type: "tool_call",
      callId: "call_1",
      name: "shell",
      status: "completed",
      detail: { type: "unknown", input: null, output: null },
      error: null,
    } as AgentTimelineItem;

    writer.push({ type: "assistant_message", text: "Running it.", messageId: "msg_1" });
    writer.push(toolCall);
    writer.end();

    expect(
      output
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([toolCall]);
  });
});
