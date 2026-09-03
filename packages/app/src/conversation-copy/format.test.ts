import { describe, expect, it } from "vitest";
import { formatAgentConversation } from "./format";

describe("formatAgentConversation", () => {
  it("formats user, assistant, and agent error messages in timeline order", () => {
    expect(
      formatAgentConversation([
        { type: "user_message", text: "  Fix the bug.  " },
        { type: "reasoning", text: "I will inspect the code." },
        {
          type: "tool_call",
          callId: "call-1",
          name: "exec_command",
          detail: { type: "shell", command: "rg bug" },
          status: "completed",
          error: null,
        },
        { type: "assistant_message", text: "Fixed it.\n" },
        { type: "error", message: "The agent stopped unexpectedly." },
      ]),
    ).toBe(
      "## User\n\nFix the bug.\n\n## Assistant\n\nFixed it.\n\n## Agent error\n\nThe agent stopped unexpectedly.",
    );
  });

  it("omits empty messages and timeline-only events", () => {
    expect(
      formatAgentConversation([
        { type: "user_message", text: "   " },
        { type: "reasoning", text: "private" },
        {
          type: "todo",
          items: [{ text: "Implement copy", completed: true }],
        },
      ]),
    ).toBe("");
  });
});
