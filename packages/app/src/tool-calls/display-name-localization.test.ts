import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";

import {
  getToolCallDisplayNameKey,
  getToolCallLocalizedSummary,
} from "./display-name-localization";

function keyFor(toolName: string, detail: ToolCallDetail, displayName: string, summary?: string) {
  return getToolCallDisplayNameKey({ toolName, detail, displayName, summary });
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

  it("prefers the specific web-search tool name over the generic search detail type", () => {
    expect(keyFor("web_search", { type: "search", query: "Paseo localization" }, "Search")).toBe(
      "toolCallDetails.names.webSearch",
    );
  });

  it("uses the nested search tool name when the outer tool is generic", () => {
    expect(
      keyFor(
        "search",
        { type: "search", toolName: "web_search", query: "Paseo localization" },
        "Search",
      ),
    ).toBe("toolCallDetails.names.webSearch");
  });

  it("recognizes the real historical web-search summary shape", () => {
    expect(
      keyFor(
        "search",
        { type: "search", query: "Codex ChatGPT extension" },
        "Search",
        "Web search:",
      ),
    ).toBe("toolCallDetails.names.webSearch");
  });

  it("removes a redundant raw Web search summary after localization", () => {
    expect(getToolCallLocalizedSummary("toolCallDetails.names.webSearch", "Web search:")).toBe(
      undefined,
    );
    expect(
      getToolCallLocalizedSummary("toolCallDetails.names.webSearch", "Paseo localization"),
    ).toBe("Paseo localization");
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
