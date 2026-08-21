import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ToolCallItem } from "@/types/stream";
import { summarizeToolCallActivity } from "./activity-summary";

function toolCall(id: string, detail: ToolCallDetail, name: string = detail.type): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(`2026-01-01T00:00:${id.padStart(2, "0")}.000Z`),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: id,
        name,
        status: "completed",
        error: null,
        detail,
      },
    },
  };
}

describe("summarizeToolCallActivity", () => {
  it("counts every call and keeps distinct action icons in first-seen order", () => {
    const result = summarizeToolCallActivity([
      toolCall("1", { type: "shell", command: "npm test" }),
      toolCall("2", { type: "read", filePath: "/repo/a.ts" }),
      toolCall("3", { type: "shell", command: "npm run lint" }),
      toolCall("4", { type: "edit", filePath: "/repo/a.ts" }),
    ]);

    expect(result).toEqual({
      toolCallCount: 4,
      iconNames: ["square_terminal", "eye", "pencil"],
    });
  });

  it("uses normalized provider tool names when details are unknown", () => {
    const unknown = { type: "unknown" as const, input: null, output: null };
    const result = summarizeToolCallActivity([
      toolCall("1", unknown, "paseo.list_agents"),
      toolCall("2", unknown, "brave-search_brave_web_search"),
    ]);

    expect(result.iconNames).toEqual(["paseo", "wrench"]);
  });
});
