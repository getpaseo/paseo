import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";

import { getToolCallDisplayNameKey } from "./display-name-localization";

function keyFor(toolName: string, detail: ToolCallDetail, displayName: string) {
  return getToolCallDisplayNameKey({ toolName, detail, displayName });
}

describe("tool-call display-name localization", () => {
  it("localizes canonical workflow tools by detail type", () => {
    expect(keyFor("read_file", { type: "read", filePath: "/tmp/a", content: "" }, "Read")).toBe(
      "toolCallDetails.names.read",
    );
    expect(keyFor("exec_command", { type: "shell", command: "pwd", output: "" }, "Shell")).toBe(
      "toolCallDetails.names.shell",
    );
    expect(
      keyFor("apply_patch", { type: "edit", filePath: "/tmp/a", unifiedDiff: "" }, "Edit"),
    ).toBe("toolCallDetails.names.edit");
  });

  it("localizes known workflow names when providers only send unknown details", () => {
    const unknown: ToolCallDetail = { type: "unknown", input: null, output: null };
    expect(keyFor("web_search", unknown, "Web Search")).toBe("toolCallDetails.names.webSearch");
    expect(keyFor("thinking", unknown, "Thinking")).toBe("toolCallDetails.names.thinking");
    expect(keyFor("terminal", unknown, "Terminal")).toBe("toolCallDetails.names.terminal");
  });

  it("preserves unknown third-party MCP tool names", () => {
    expect(
      keyFor(
        "mcp__acme__publish_report",
        { type: "unknown", input: null, output: null },
        "acme.publish_report",
      ),
    ).toBeNull();
  });
});
