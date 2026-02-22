import { describe, expect, it } from "vitest";
import { curateAgentActivity } from "./activity-curator.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

function toolCallItem(params: {
  callId: string;
  name: string;
  status?: "running" | "completed" | "failed" | "canceled";
  input?: unknown | null;
  output?: unknown | null;
  error?: unknown;
  metadata?: Record<string, unknown>;
  detail?: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"];
}): Extract<AgentTimelineItem, { type: "tool_call" }> {
  const status = params.status ?? "completed";
  const detail =
    params.detail ?? {
      type: "unknown" as const,
      input: params.input ?? null,
      output: params.output ?? null,
    };
  return {
    type: "tool_call",
    callId: params.callId,
    name: params.name,
    status,
    detail,
    error: status === "failed" ? params.error ?? { message: "failed" } : null,
    metadata: params.metadata,
  };
}

describe("curateAgentActivity", () => {
  it("renders user/assistant/reasoning entries", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Hello" },
      { type: "assistant_message", text: "Hi" },
      { type: "reasoning", text: "Thinking" },
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain("[User] Hello");
    expect(result).toContain("Hi");
    expect(result).toContain("[Thought] Thinking");
  });

  it("uses detail enrichment for tool summaries", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "read-1",
        name: "read_file",
        detail: {
          type: "read",
          filePath: "src/index.ts",
          content: "console.log('hi')",
        },
      }),
      toolCallItem({
        callId: "shell-1",
        name: "shell",
        detail: {
          type: "shell",
          command: "npm test",
          output: "ok",
          exitCode: 0,
        },
      }),
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain("[Read] src/index.ts");
    expect(result).toContain("[Shell] npm test");
  });

  it("does not infer summary from raw input when detail is missing", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "shell-no-detail",
        name: "exec_command",
        status: "running",
        input: { command: "npm run lint" },
      }),
      toolCallItem({
        callId: "read-no-detail",
        name: "read_file",
        status: "running",
        input: { path: "src/index.ts" },
      }),
      toolCallItem({
        callId: "search-no-detail",
        name: "web_search",
        status: "running",
        input: { query: "zod union" },
      }),
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain("[Exec Command]");
    expect(result).toContain("[Read File]");
    expect(result).toContain("[Web Search]");
    expect(result).not.toContain("npm run lint");
    expect(result).not.toContain("src/index.ts");
    expect(result).not.toContain("zod union");
  });

  it("falls back to input json for likely external tools", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "mcp-1",
        name: "paseo__create_agent",
        input: { cwd: "/tmp/repo", initialPrompt: "do the thing" },
      }),
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toBe(
      '[paseo__create_agent] {"cwd":"/tmp/repo","initialPrompt":"do the thing"}'
    );
  });

  it("collapses repeated tool updates by callId", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "task-1",
        name: "Task",
        status: "running",
        detail: {
          type: "sub_agent",
          subAgentType: "Explore",
          description: "Investigate repository",
          log: "[Read] README.md",
          actions: [
            {
              index: 1,
              toolName: "Read",
              summary: "README.md",
            },
          ],
        },
      }),
      toolCallItem({
        callId: "task-1",
        name: "Task",
        status: "running",
        detail: {
          type: "sub_agent",
          subAgentType: "Explore",
          description: "Investigate repository",
          log: "[Read] README.md\n[Bash] ls",
          actions: [
            {
              index: 1,
              toolName: "Read",
              summary: "README.md",
            },
            {
              index: 2,
              toolName: "Bash",
              summary: "ls",
            },
          ],
        },
      }),
    ];

    const result = curateAgentActivity(timeline);
    const lines = result.split("\n");

    expect(lines.filter((line) => line.startsWith("[Explore]"))).toEqual([
      "[Explore] Investigate repository",
    ]);
  });

  it("renders todo/error/compaction entries", () => {
    const timeline: AgentTimelineItem[] = [
      {
        type: "todo",
        items: [
          { text: "One", completed: false },
          { text: "Two", completed: true },
        ],
      },
      { type: "error", message: "boom" },
      { type: "compaction", status: "completed", trigger: "auto" },
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain("[Tasks]");
    expect(result).toContain("- [ ] One");
    expect(result).toContain("- [x] Two");
    expect(result).toContain("[Error] boom");
    expect(result).toContain("[Compacted]");
  });

  it("truncates to maxItems", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Message 1" },
      { type: "user_message", text: "Message 2" },
      { type: "user_message", text: "Message 3" },
      { type: "user_message", text: "Message 4" },
    ];

    const result = curateAgentActivity(timeline, { maxItems: 2 });

    expect(result).not.toContain("Message 1");
    expect(result).not.toContain("Message 2");
    expect(result).toContain("Message 3");
    expect(result).toContain("Message 4");
  });

  it("returns a default message when timeline is empty", () => {
    expect(curateAgentActivity([])).toBe("No activity to display.");
  });
});
