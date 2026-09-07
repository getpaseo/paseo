import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamPiHistory, type PiCapturedUserMessageEntry } from "./history-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

async function collectHistory(
  messages: PiAgentMessage[],
  userEntries: PiCapturedUserMessageEntry[] = [],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory("pi", messages, userEntries)) {
    events.push(event);
  }
  return events;
}

describe("Pi history mapper", () => {
  test("replays user, assistant, reasoning, and completed tool calls", async () => {
    await expect(
      collectHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            { type: "image", data: "base64", mimeType: "image/png" },
            { type: "text", text: "then answer" },
          ],
        },
        {
          role: "assistant",
          responseId: "response-1",
          content: [
            { type: "thinking", thinking: "checking file" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
            { type: "text", text: "done" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "read this\n\nthen answer",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "reasoning", text: "checking file" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "running",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: undefined,
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "done", messageId: "response-1" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "completed",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: "file contents",
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
    ]);
  });

  test("replays bash execution records as completed shell calls", async () => {
    await expect(
      collectHistory([
        {
          role: "bashExecution",
          command: "echo hi",
          output: "hi\n",
          exitCode: 0,
          timestamp: 123,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-bash-123",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
          error: null,
        },
      },
    ]);
  });

  test("replays non-notice custom messages as assistant text, matching the live path", async () => {
    await expect(
      collectHistory([{ role: "custom", content: "Extension command output" }]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "Extension command output" },
      },
    ]);
  });

  test("formats structured Tintinweb agent notifications as compact summaries", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          customType: "subagent-notification",
          content: [
            "Background agent group completed: 2 agent(s) finished (partial - others still running)",
            "",
            "<task-notification>raw XML</task-notification>",
            "",
            "Use get_subagent_result for full output.",
          ].join("\n"),
          details: {
            id: "agent-1",
            description: "inspect Paseo pin",
            status: "completed",
            toolUses: 10,
            turnCount: 4,
            maxTurns: 12,
            totalTokens: 101_088,
            durationMs: 36_787,
            outputFile: "/tmp/agent-1.output",
            resultPreview: "- Source pins: `flake.nix`",
            others: [
              {
                id: "agent-2",
                description: "trace Paseo services",
                status: "steered",
                toolUses: 19,
                turnCount: 8,
                totalTokens: 110_374,
                durationMs: 47_904,
                outputFile: "/tmp/agent-2.output",
                resultPreview: "Read-only findings; no files changed.",
              },
            ],
          },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: [
            "**Background agent results (other agents still running)**",
            "",
            "**Agent completed: inspect Paseo pin**",
            "4/12 turns | 10 tool uses | 101.1k tokens | 36.8s",
            "",
            "- Source pins: `flake.nix`",
            "",
            "Transcript: `/tmp/agent-1.output`",
            "",
            "---",
            "",
            "**Agent completed at turn limit: trace Paseo services**",
            "8 turns | 19 tool uses | 110.4k tokens | 47.9s",
            "",
            "Read-only findings; no files changed.",
            "",
            "Transcript: `/tmp/agent-2.output`",
            "",
            "Use `get_subagent_result` for full output.",
          ].join("\n"),
        },
      },
    ]);
  });

  test("falls back to Tintinweb task notification XML when details are unavailable", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          customType: "subagent-notification",
          content: [
            "<task-notification>",
            "<task-id>agent-1</task-id>",
            "<output-file>/tmp/agent-1.output</output-file>",
            '<summary>Agent "inspect Paseo pin" completed</summary>',
            "<result>- Source &lt;pin&gt;</result>",
            "<usage><total_tokens>101088</total_tokens><tool_uses>10</tool_uses><duration_ms>36787</duration_ms></usage>",
            "</task-notification>",
          ].join("\n"),
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: [
            '**Agent "inspect Paseo pin" completed**',
            "10 tool uses | 101.1k tokens | 36.8s",
            "",
            "- Source <pin>",
            "",
            "Transcript: `/tmp/agent-1.output`",
          ].join("\n"),
        },
      },
    ]);
  });

  test("uses Pi tree entry ids for replayed user messages", async () => {
    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "assistant", content: [{ type: "text", text: "first answer" }] },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "first answer",
          messageId: "pi-history-assistant-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });
});
