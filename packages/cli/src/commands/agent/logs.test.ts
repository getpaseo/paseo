import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { createFollowTranscriptWriter, formatAgentActivityTranscript } from "./logs.js";

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

    writer.push({ type: "assistant_message", text: "first line", messageId: "msg_1" });
    expect(chunks.join("")).toBe("first line");

    writer.push({ type: "assistant_message", text: "\nsecond", messageId: "msg_1" });
    expect(chunks.join("")).toBe("first line\nsecond");

    writer.push({ type: "assistant_message", text: " line\n", messageId: "msg_1" });
    expect(chunks.join("")).toBe("first line\nsecond line");

    writer.end();
    expect(chunks.join("")).toBe("first line\nsecond line\n");
  });

  it("emits the same transcript the one-shot command prints for the same items", () => {
    const items: AgentTimelineItem[] = [
      { type: "assistant_message", text: "Plan for paseo-pr", messageId: "msg_1" },
      { type: "assistant_message", text: "-cycle:\n- build\n- test\n", messageId: "msg_1" },
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

  it("keeps interior blank lines and drops trailing whitespace", () => {
    const output = collect([
      { type: "assistant_message", text: "  # Title\n\nBody\n\n  ", messageId: "msg_1" },
    ]);

    expect(output).toBe("# Title\n\nBody\n");
  });
});
