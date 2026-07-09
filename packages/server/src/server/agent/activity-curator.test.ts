import { describe, expect, it } from "vitest";
import { buildAgentForkContextAttachment, curateAgentActivity } from "./activity-curator.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

function toolCallItem(params: {
  callId: string;
  name: string;
  status?: "running" | "completed" | "failed" | "canceled";
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  detail?: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"];
}): Extract<AgentTimelineItem, { type: "tool_call" }> {
  const status = params.status ?? "completed";
  const detail = params.detail ?? {
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
    error: status === "failed" ? (params.error ?? { message: "failed" }) : null,
    metadata: params.metadata,
  };
}

function row(seq: number, item: AgentTimelineItem): AgentTimelineRow {
  return {
    seq,
    timestamp: `2026-06-28T00:00:${String(seq).padStart(2, "0")}.000Z`,
    item,
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

  it("renders terminal tool calls as one-line command summaries", () => {
    const timeline: AgentTimelineItem[] = [
      toolCallItem({
        callId: "terminal-1",
        name: "terminal",
        detail: {
          type: "plain_text",
          label: `skills/paseo-chat/bin/chat.sh post --room storage-revamp --body $'first line

second line'`,
          icon: "square_terminal",
        },
      }),
    ];

    const result = curateAgentActivity(timeline);

    expect(result).toContain(
      "[Terminal] skills/paseo-chat/bin/chat.sh post --room storage-revamp --body $'first line second line'",
    );
    expect(result).not.toContain("[Interacted with terminal]");
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

    expect(result).toBe('[paseo__create_agent] {"cwd":"/tmp/repo","initialPrompt":"do the thing"}');
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
        },
      }),
    ];

    const result = curateAgentActivity(timeline);
    const lines = result.split("\n");

    expect(lines.filter((line) => line.startsWith("[Explore]"))).toEqual([
      "[Explore] Investigate repository",
    ]);
  });

  it("keeps nested sub-agent logs beside the sub-agent that produced them", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "assistant_message", text: "Before first child." },
      toolCallItem({
        callId: "child-1",
        name: "Sub-agent",
        detail: {
          type: "sub_agent",
          subAgentType: "Child one",
          description: "First investigation",
          log: "[Assistant] First child result.",
        },
      }),
      { type: "assistant_message", text: "Between children." },
      toolCallItem({
        callId: "child-2",
        name: "Sub-agent",
        detail: {
          type: "sub_agent",
          subAgentType: "Child two",
          description: "Second investigation",
          log: "[Assistant] Second child result.",
        },
      }),
      { type: "assistant_message", text: "After second child." },
    ];

    const result = curateAgentActivity(timeline, { labelAssistantMessages: true });

    expect(result.split("\n")).toEqual([
      "[Assistant] Before first child.",
      "[Child one] First investigation",
      "[Assistant] First child result.",
      "[Assistant] Between children.",
      "[Child two] Second investigation",
      "[Assistant] Second child result.",
      "[Assistant] After second child.",
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

  it("builds fork context from user messages, assistant messages, and tool summaries", () => {
    const result = buildAgentForkContextAttachment({
      agentTitle: "Source Agent",
      cwd: "/repo",
      boundaryMessageId: "assistant-1",
      rows: [
        row(1, { type: "user_message", text: "Ship the thing", messageId: "user-1" }),
        row(2, { type: "reasoning", text: "private chain of thought" }),
        row(
          3,
          toolCallItem({
            callId: "read-1",
            name: "read_file",
            detail: {
              type: "read",
              filePath: "src/index.ts",
              content: "console.log('hi')",
            },
          }),
        ),
        row(
          4,
          toolCallItem({
            callId: "external-1",
            name: "paseo__create_agent",
            input: { initialPrompt: "do not include raw external tool input" },
          }),
        ),
        row(5, {
          type: "assistant_message",
          text: "Done.",
          messageId: "assistant-1",
        }),
        row(6, {
          type: "assistant_message",
          text: "Later answer.",
          messageId: "assistant-2",
        }),
      ],
    });

    expect(result.boundaryMessageId).toBe("assistant-1");
    expect(result.attachment).toMatchObject({
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
    });
    expect(result.attachment.text).toContain("Source agent: Source Agent");
    expect(result.attachment.text).toContain("Source directory: /repo");
    expect(result.attachment.text).toContain("[User] Ship the thing");
    expect(result.attachment.text).toContain("[Read] src/index.ts");
    expect(result.attachment.text).toContain("[paseo__create_agent]");
    expect(result.attachment.text).toContain("[Assistant] Done.");
    expect(result.attachment.text).not.toContain("private chain of thought");
    expect(result.attachment.text).not.toContain("do not include raw external tool input");
    expect(result.attachment.text).not.toContain("Later answer.");
  });

  it("does not cap fork context to the generic recent activity limit", () => {
    const messageRows = Array.from({ length: 25 }, (_, index) =>
      row(index + 1, {
        type: "user_message",
        text: `Message ${index + 1}`,
        messageId: `user-${index + 1}`,
      }),
    );
    const result = buildAgentForkContextAttachment({
      boundaryMessageId: "assistant-1",
      rows: [
        ...messageRows,
        row(26, {
          type: "assistant_message",
          text: "Done.",
          messageId: "assistant-1",
        }),
      ],
    });

    expect(result.itemCount).toBe(26);
    expect(result.attachment.text).toContain("[User] Message 1");
    expect(result.attachment.text).toContain("[User] Message 25");
    expect(result.attachment.text).toContain("[Assistant] Done.");
  });

  it("selects the fork boundary before collapsing later tool updates", () => {
    const result = buildAgentForkContextAttachment({
      boundaryMessageId: "assistant-1",
      rows: [
        row(1, { type: "user_message", text: "Run it", messageId: "user-1" }),
        row(
          2,
          toolCallItem({
            callId: "terminal-1",
            name: "terminal",
            status: "running",
            detail: {
              type: "plain_text",
              label: "before boundary",
            },
          }),
        ),
        row(3, {
          type: "assistant_message",
          text: "Partial result.",
          messageId: "assistant-1",
        }),
        row(
          4,
          toolCallItem({
            callId: "terminal-1",
            name: "terminal",
            status: "completed",
            detail: {
              type: "plain_text",
              label: "after boundary",
            },
          }),
        ),
      ],
    });

    expect(result.attachment.text).toContain("[Terminal] before boundary");
    expect(result.attachment.text).toContain("[Assistant] Partial result.");
    expect(result.attachment.text).not.toContain("after boundary");
  });

  it("rejects missing assistant boundaries instead of silently using the wrong context", () => {
    expect(() =>
      buildAgentForkContextAttachment({
        boundaryMessageId: "missing",
        rows: [row(1, { type: "assistant_message", text: "Done.", messageId: "assistant-1" })],
      }),
    ).toThrow("Selected assistant message is no longer available.");
  });
});
