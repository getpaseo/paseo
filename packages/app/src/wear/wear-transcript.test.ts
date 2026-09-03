import type { AgentTimelineItem, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";

import { WEAR_PROTOCOL_VERSION } from "./wear-protocol";
import { buildWearTranscript, isTranscriptEntry, MAX_TRANSCRIPT_ENTRIES } from "./wear-transcript";

const NOW = new Date("2026-07-29T12:00:00Z").getTime();

function build(items: AgentTimelineItem[], hasOlder = false) {
  return buildWearTranscript({ agentId: "agent-1", serverId: "srv-1", items, hasOlder }, NOW);
}

function toolCall(
  name: string,
  detail: ToolCallDetail,
  status: "running" | "completed" | "failed" | "canceled" = "completed",
): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "call-1",
    name,
    detail,
    status,
    error: status === "failed" ? "boom" : null,
  } as AgentTimelineItem;
}

function textOf(items: AgentTimelineItem[]): string {
  const entry = build(items).entries[0];
  return entry.text;
}

describe("buildWearTranscript envelope", () => {
  it("carries identity and the protocol version", () => {
    const transcript = build([{ type: "user_message", text: "Fix the tests" }]);
    expect(transcript).toEqual({
      v: WEAR_PROTOCOL_VERSION,
      agentId: "agent-1",
      serverId: "srv-1",
      updatedAt: NOW,
      entries: [{ kind: "user", text: "Fix the tests" }],
      truncated: false,
    });
  });

  it("keeps entries oldest to newest", () => {
    const transcript = build([
      { type: "user_message", text: "first" },
      { type: "assistant_message", text: "second" },
      { type: "user_message", text: "third" },
    ]);
    expect(transcript.entries.map((entry) => entry.text)).toEqual(["first", "second", "third"]);
  });

  it("reports truncated when the daemon has older history", () => {
    const transcript = build([{ type: "user_message", text: "hi" }], true);
    expect(transcript.truncated).toBe(true);
  });
});

describe("buildWearTranscript item kinds", () => {
  it("maps messages, tool calls and errors", () => {
    const transcript = build([
      { type: "user_message", text: "Fix the tests" },
      toolCall("Bash", { type: "shell", command: "git push origin main" }),
      { type: "assistant_message", text: "Pushed. CI is running." },
      { type: "error", message: "Turn failed: rate limited" },
    ]);

    expect(transcript.entries).toEqual([
      { kind: "user", text: "Fix the tests" },
      { kind: "tool", text: "Bash: git push origin main" },
      { kind: "assistant", text: "Pushed. CI is running." },
      { kind: "error", text: "Turn failed: rate limited" },
    ]);
  });

  it("skips reasoning, todos and compaction entirely", () => {
    const transcript = build([
      { type: "reasoning", text: "thinking about it" },
      { type: "todo", items: [{ text: "ship it", completed: false }] },
      { type: "compaction", status: "completed" },
      { type: "user_message", text: "kept" },
    ]);
    expect(transcript.entries).toEqual([{ kind: "user", text: "kept" }]);
  });

  it("drops a message that normalises to nothing rather than emitting a blank row", () => {
    expect(build([{ type: "user_message", text: "   \n\n  " }]).entries).toEqual([]);
  });
});

describe("buildWearTranscript tool summaries", () => {
  it("picks the most specific string from each detail variant", () => {
    const cases: Array<[ToolCallDetail, string]> = [
      [{ type: "shell", command: "npm test" }, "Bash: npm test"],
      [{ type: "read", filePath: "/src/app.ts" }, "Bash: /src/app.ts"],
      [{ type: "edit", filePath: "/src/edit.ts" }, "Bash: /src/edit.ts"],
      [{ type: "write", filePath: "/src/write.ts" }, "Bash: /src/write.ts"],
      [{ type: "search", query: "useEffect" }, "Bash: useEffect"],
      [{ type: "fetch", url: "https://paseo.sh" }, "Bash: https://paseo.sh"],
      [
        { type: "worktree_setup", worktreePath: "/wt/x", branchName: "b", log: "", commands: [] },
        "Bash: /wt/x",
      ],
      [{ type: "sub_agent", description: "review the diff", log: "" }, "Bash: review the diff"],
      [{ type: "plan", text: "Step one\nStep two" }, "Bash: Step one"],
      [{ type: "plain_text", label: "Ran", text: "did a thing" }, "Bash: did a thing"],
    ];

    for (const [detail, expected] of cases) {
      expect(textOf([toolCall("Bash", detail)])).toBe(expected);
    }
  });

  it("falls back to the sub-agent type when there is no description", () => {
    expect(
      textOf([toolCall("Task", { type: "sub_agent", subAgentType: "reviewer", log: "" })]),
    ).toBe("Task: reviewer");
  });

  it("probes a conventionally named field on an untyped detail", () => {
    expect(
      textOf([toolCall("Custom", { type: "unknown", input: { command: "make" }, output: null })]),
    ).toBe("Custom: make");
  });

  it("emits just the name when nothing specific is available", () => {
    expect(textOf([toolCall("Mystery", { type: "unknown", input: null, output: null })])).toBe(
      "Mystery",
    );
    expect(textOf([toolCall("Plain", { type: "plain_text" })])).toBe("Plain");
  });

  it("flattens a multi-line command onto one line", () => {
    expect(textOf([toolCall("Bash", { type: "shell", command: "a\n  b\n\n  c" })])).toBe(
      "Bash: a b c",
    );
  });

  it("marks a failed call and keeps the marker even when the line is capped", () => {
    expect(textOf([toolCall("Bash", { type: "shell", command: "npm test" }, "failed")])).toBe(
      "Bash: npm test (failed)",
    );

    const long = textOf([toolCall("Bash", { type: "shell", command: "x".repeat(500) }, "failed")]);
    expect(long.endsWith("… (failed)")).toBe(true);
    // The marker is reserved out of the budget rather than added on top of it: it is
    // never what gets cut, and the entry still honours the 100-character cap.
    expect(long).toHaveLength(100);
  });

  it("does not mark running, completed or canceled calls", () => {
    for (const status of ["running", "completed", "canceled"] as const) {
      expect(textOf([toolCall("Bash", { type: "shell", command: "ls" }, status)])).toBe("Bash: ls");
    }
  });

  it("caps the tool line at 100 characters", () => {
    const text = textOf([toolCall("Bash", { type: "shell", command: "y".repeat(400) })]);
    expect(text).toHaveLength(100);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("buildWearTranscript text normalisation", () => {
  it("preserves single newlines in prose", () => {
    expect(textOf([{ type: "user_message", text: "one\ntwo\nthree" }])).toBe("one\ntwo\nthree");
  });

  it("collapses runs of three or more newlines to a single blank line", () => {
    expect(textOf([{ type: "assistant_message", text: "a\n\n\n\n\nb" }])).toBe("a\n\nb");
    // Exactly one blank line is already the target and must survive untouched.
    expect(textOf([{ type: "assistant_message", text: "a\n\nb" }])).toBe("a\n\nb");
  });

  it("collapses horizontal whitespace without touching line structure", () => {
    expect(textOf([{ type: "user_message", text: "  a \t  b  \n   c   " }])).toBe("a b\nc");
  });

  it("normalises carriage returns", () => {
    expect(textOf([{ type: "user_message", text: "a\r\nb" }])).toBe("a\nb");
  });

  it("caps messages at 300 characters and errors at 200", () => {
    const message = textOf([{ type: "user_message", text: "u".repeat(500) }]);
    expect(message).toHaveLength(300);
    expect(message.endsWith("…")).toBe(true);

    const error = textOf([{ type: "error", message: "e".repeat(500) }]);
    expect(error).toHaveLength(200);
    expect(error.endsWith("…")).toBe(true);
  });

  it("leaves text at the cap unmarked", () => {
    expect(textOf([{ type: "user_message", text: "u".repeat(300) }])).toBe("u".repeat(300));
  });

  it("never leaves half an emoji at a truncation boundary", () => {
    // The surrogate pair straddles the slice point. Keeping only its high half would
    // render as a replacement box on the watch.
    const text = textOf([{ type: "user_message", text: `${"a".repeat(298)}😀${"b".repeat(50)}` }]);
    expect(text).toBe(`${"a".repeat(298)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
  });

  it("keeps an emoji that fits entirely inside the cap", () => {
    const text = textOf([{ type: "user_message", text: `${"a".repeat(297)}😀${"b".repeat(50)}` }]);
    expect(text).toBe(`${"a".repeat(297)}😀…`);
  });
});

describe("isTranscriptEntry", () => {
  it("agrees with what the projection actually keeps", () => {
    const kept: AgentTimelineItem[] = [
      { type: "user_message", text: "hi" },
      { type: "assistant_message", text: "hello" },
      { type: "error", message: "boom" },
      toolCall("Bash", { type: "shell", command: "ls" }),
    ];
    const dropped: AgentTimelineItem[] = [
      { type: "reasoning", text: "thinking" },
      { type: "todo", items: [{ text: "ship it", completed: false }] },
      { type: "compaction", status: "completed" },
    ];

    for (const item of kept) expect(isTranscriptEntry(item)).toBe(true);
    for (const item of dropped) expect(isTranscriptEntry(item)).toBe(false);

    // The predicate exists to budget paging, so it must match the projection exactly.
    expect(build(kept).entries).toHaveLength(kept.length);
    expect(build(dropped).entries).toHaveLength(0);
  });
});

describe("buildWearTranscript limits", () => {
  it("keeps the newest entries when there are more than the cap", () => {
    const items: AgentTimelineItem[] = Array.from({ length: 150 }, (_, index) => ({
      type: "user_message",
      text: `message ${index}`,
    }));

    const transcript = build(items);
    expect(transcript.entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    // Oldest dropped, newest kept — the tail is what the watch opened to read.
    expect(transcript.entries[0].text).toBe("message 50");
    expect(transcript.entries.at(-1)?.text).toBe("message 149");
    expect(transcript.truncated).toBe(true);
  });

  it("drops oldest entries until the serialised payload fits in 48 KB", () => {
    // Multi-byte text is the only way to exceed the byte cap within the entry cap,
    // which is exactly why the size check counts UTF-8 bytes and not characters.
    const items: AgentTimelineItem[] = Array.from({ length: 100 }, (_, index) => ({
      type: "assistant_message",
      text: `${index}${"漢".repeat(299)}`,
    }));

    const transcript = build(items);
    const bytes = Buffer.byteLength(JSON.stringify(transcript), "utf8");
    expect(bytes).toBeLessThanOrEqual(48 * 1024);
    expect(transcript.entries.length).toBeLessThan(100);
    expect(transcript.truncated).toBe(true);
    // Dropped from the front: the newest entry always survives.
    expect(transcript.entries.at(-1)?.text.startsWith("99")).toBe(true);
  });

  it("does not report truncation when everything fits", () => {
    const transcript = build([
      { type: "user_message", text: "short" },
      { type: "assistant_message", text: "also short" },
    ]);
    expect(transcript.truncated).toBe(false);
  });

  it("handles an empty timeline", () => {
    expect(build([])).toMatchObject({ entries: [], truncated: false });
  });
});
