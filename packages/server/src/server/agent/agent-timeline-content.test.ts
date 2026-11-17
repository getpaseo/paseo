import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";

function serializedBytes(item: AgentTimelineItem): number {
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}

describe("agent timeline content", () => {
  test("returns an item within budget unchanged", () => {
    const item: AgentTimelineItem = {
      type: "tool_call",
      callId: "small",
      name: "Bash",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "ls", output: "x".repeat(60 * 1024) },
    };
    expect(limitAgentTimelineItemContent(item)).toBe(item);
  });

  test.each([false, true])(
    "cuts oversized shell output and keeps short fields whole (failed=%s)",
    (failed) => {
      const text = "x".repeat(1024 * 1024) + "🙂";
      const item = limitAgentTimelineItemContent({
        type: "tool_call",
        callId: "large-shell",
        name: "Bash",
        status: failed ? "failed" : "completed",
        detail: { type: "shell", command: "echo large", output: text },
        error: failed ? { content: text } : null,
      });
      expect(item).toMatchObject({
        callId: "large-shell",
        name: "Bash",
        detail: { type: "shell", command: "echo large" },
      });
      if (item.type !== "tool_call" || item.detail.type !== "shell") throw new Error("shape");
      expect(item.detail.output).toMatch(/^x+…\[truncated \d{3}\.\d KB\]$/);
      expect(serializedBytes(item)).toBeLessThanOrEqual(64 * 1024);
    },
  );

  test("replaces an oversized data URL in an unknown tool result with a marker", () => {
    const url = `data:image/jpeg;base64,${"A".repeat(14 * 1024 * 1024)}`;
    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "screenshot",
      name: "node_repl.js",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { index: 1 },
        output: { content: [{ type: "image", url }], note: "captured" },
      },
    });
    expect(item).toEqual({
      type: "tool_call",
      callId: "screenshot",
      name: "node_repl.js",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { index: 1 },
        output: { content: [{ type: "image", url: "…[truncated 14.0 MB]" }], note: "captured" },
      },
    });
  });

  test("gives non-tool items a 256 KiB budget", () => {
    const text = "a".repeat(10 * 1024 * 1024);
    const item = limitAgentTimelineItemContent({ type: "assistant_message", text });
    if (item.type !== "assistant_message") throw new Error("shape");
    expect(item.text).toMatch(/^a+…\[truncated 9\.\d MB\]$/);
    expect(item.text.length).toBeGreaterThan(200 * 1024);
    expect(serializedBytes(item)).toBeLessThanOrEqual(256 * 1024);
  });

  test("bounds an item whose structure alone exceeds the budget", () => {
    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "many",
      name: "query",
      status: "completed",
      error: null,
      detail: { type: "unknown", input: null, output: Array.from({ length: 1_000_000 }, () => 1) },
    });
    if (item.type !== "tool_call" || item.detail.type !== "unknown") throw new Error("shape");
    const output = item.detail.output as unknown[];
    expect(output.length).toBeLessThan(1_000_000);
    expect(output.every((value) => value === 1)).toBe(true);
    expect(serializedBytes(item)).toBeLessThanOrEqual(64 * 1024);
  });

  test("keeps short strings whole and limits idempotently when an item has many strings", () => {
    const callId = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId,
      name: "mcp__search__files",
      status: "completed",
      error: null,
      detail: {
        type: "unknown",
        input: { query: "useWorkspaceSomethingVeryDescriptive" },
        output: Array.from(
          { length: 10_000 },
          (_, index) => `${String(index).padStart(5, "0")}${"p".repeat(28)}`,
        ),
      },
    });
    if (item.type !== "tool_call" || item.detail.type !== "unknown") throw new Error("shape");
    expect(item.callId).toBe(callId);
    expect(item.detail.input).toEqual({ query: "useWorkspaceSomethingVeryDescriptive" });
    const output = item.detail.output as string[];
    expect(output.length).toBeLessThan(10_000);
    expect(output.every((path) => path.length === 33)).toBe(true);
    expect(serializedBytes(item)).toBeLessThanOrEqual(64 * 1024);
    expect(limitAgentTimelineItemContent(item)).toBe(item);
  });

  test("keeps a long typed array valid against the wire schema", () => {
    const item = limitAgentTimelineItemContent({
      type: "todo",
      items: Array.from({ length: 20_000 }, (_, index) => ({
        text: `Task ${index}`,
        completed: false,
      })),
    });
    if (item.type !== "todo") throw new Error("shape");
    expect(item.items.length).toBeLessThan(20_000);
    expect(AgentTimelineItemPayloadSchema.safeParse(item).success).toBe(true);
    expect(serializedBytes(item)).toBeLessThanOrEqual(256 * 1024);
  });

  test("is stable on an already-limited item", () => {
    const item = limitAgentTimelineItemContent({
      type: "reasoning",
      text: "r".repeat(1024 * 1024),
    });
    expect(limitAgentTimelineItemContent(item)).toBe(item);
  });
});
