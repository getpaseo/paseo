import { describe, expect, it } from "vitest";

import {
  buildAgentMessageDisplay,
  buildPaseoToolDisplay,
  getPaseoToolTargetAgentId,
  MAX_SUMMARY_CHARS,
  PASEO_TOOL_NAMES,
} from "./index.js";

function display(toolName: string, input: unknown, targetAgentTitle?: string) {
  return buildPaseoToolDisplay({
    toolName,
    detail: { type: "unknown", input, output: null },
    ...(targetAgentTitle ? { targetAgentTitle } : {}),
  });
}

describe("Paseo tool display", () => {
  it.each([
    [
      "send_agent_prompt",
      { agentId: "agt_1", prompt: "Fix the failing test" },
      "Send message",
      "Fix the failing test",
    ],
    ["create_agent", { title: "Reviewer", initialPrompt: "Review it" }, "Create agent", "Reviewer"],
    ["create_agent", { initialPrompt: "Review it" }, "Create agent", "Review it"],
    ["get_agent_status", { agentId: "agt_1" }, "Check agent", "agt_1"],
    ["update_agent", { agentId: "agt_1", name: "Renamed" }, "Update agent", "Renamed"],
    ["create_workspace", { path: "/tmp/repo/feature-x" }, "Create workspace", "feature-x"],
    ["create_workspace", { title: "Docs", branchName: "docs" }, "Create workspace", "Docs"],
    ["start_workspace_script", { scriptName: "web" }, "Start script", "web"],
    ["send_terminal_keys", { terminalId: "t1", keys: "npm test" }, "Send keys", "npm test"],
    ["create_schedule", { prompt: "Check CI", cron: "0 9 * * 1" }, "Create schedule", "0 9 * * 1"],
    ["browser_navigate", { url: "https://paseo.sh" }, "Navigate", "https://paseo.sh"],
    [
      "browser_upload",
      { ref: "@e1", filePaths: ["/a.png", "/b.png"] },
      "Upload files",
      "/a.png +1",
    ],
    ["browser_resize", { width: 800, height: 600 }, "Resize browser", "800×600"],
  ])("presents %s with a fixed label and its context", (tool, input, label, summary) => {
    expect(display(`mcp__paseo__${tool}`, input)).toEqual({ displayName: label, summary });
  });

  it("omits the summary when a call has no context", () => {
    expect(display("mcp__paseo__list_agents", {})).toEqual({ displayName: "List agents" });
  });

  it("recognizes every Paseo namespace format", () => {
    for (const name of ["mcp__paseo__kill_agent", "paseo.kill_agent", "paseo_remote.kill_agent"]) {
      expect(display(name, { agentId: "agt_1" })?.displayName).toBe("Kill agent");
    }
  });

  it("returns null outside the Paseo namespace, including speak", () => {
    expect(display("Bash", {})).toBeNull();
    expect(display("mcp__paseo__speak", { text: "hi" })).toBeNull();
  });

  it("humanizes a Paseo tool that has no catalog entry", () => {
    expect(display("mcp__paseo__brand_new_tool", {})).toEqual({ displayName: "Brand new tool" });
  });

  it("prefers the known agent title over the agent ID", () => {
    expect(display("mcp__paseo__cancel_agent", { agentId: "agt_1" }, "Reviewer")).toEqual({
      displayName: "Cancel agent",
      summary: "Reviewer",
    });
    expect(
      getPaseoToolTargetAgentId("mcp__paseo__cancel_agent", {
        type: "unknown",
        input: { agentId: "agt_1" },
        output: null,
      }),
    ).toBe("agt_1");
    expect(
      getPaseoToolTargetAgentId("Bash", { type: "unknown", input: { agentId: "x" }, output: null }),
    ).toBeNull();
  });

  it("truncates a massive single-line prompt and collapses whitespace", () => {
    const prompt = `Line one\n\n   line two ${"x".repeat(1_000_000)}`;
    const summary = display("mcp__paseo__send_agent_prompt", { agentId: "a", prompt })?.summary;
    expect(summary).toHaveLength(MAX_SUMMARY_CHARS);
    expect(summary?.startsWith("Line one line two xxx")).toBe(true);
    expect(summary?.endsWith("…")).toBe(true);
  });

  it("bounds the scan even when the prompt opens with a wall of whitespace", () => {
    const prompt = `${" ".repeat(10_000)}hidden`;
    const summary = display("mcp__paseo__send_agent_prompt", { agentId: "a", prompt })?.summary;
    expect(summary).toBeUndefined();
  });

  it("keeps a short prompt intact", () => {
    expect(
      display("mcp__paseo__send_agent_prompt", { agentId: "a", prompt: " hi\nthere " })?.summary,
    ).toBe("hi there");
  });

  it("catalogs tool names as lowercase leaf names", () => {
    for (const name of PASEO_TOOL_NAMES) {
      expect(name).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("agent message display", () => {
  it.each([
    ["message", "Message received"],
    ["finished", "Agent finished"],
    ["errored", "Agent errored"],
    ["permission-required", "Agent needs permission"],
    ["closed", "Agent closed"],
  ] as const)("labels %s noun-first with the sender as context", (event, label) => {
    const result = buildAgentMessageDisplay({
      event,
      sender: { id: "srv::agt_1", title: "QA messenger" },
      text: "Done.",
    });
    expect(result.displayName).toBe(label);
    expect(result.summary).toBe("QA messenger");
    expect(result.detail).toEqual({ type: "plain_text", text: "From agent: srv::agt_1\n\nDone." });
  });

  it("falls back to the sender ID and truncates a long title", () => {
    expect(
      buildAgentMessageDisplay({ event: "finished", sender: { id: "srv::agt_1" }, text: "" })
        .summary,
    ).toBe("srv::agt_1");
    const summary = buildAgentMessageDisplay({
      event: "finished",
      sender: { id: "a", title: "t".repeat(500) },
      text: "",
    }).summary;
    expect(summary).toHaveLength(MAX_SUMMARY_CHARS);
  });
});
