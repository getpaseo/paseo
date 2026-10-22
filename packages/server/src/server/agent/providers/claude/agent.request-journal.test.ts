import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

describe("Claude session request journal replay", () => {
  let root: string;
  let cwd: string;
  let configDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "claude-request-journal-"));
    cwd = path.join(root, "repo");
    configDir = path.join(root, "claude");
    mkdirSync(cwd);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function replay(records: unknown[]): Promise<AgentTimelineItem[]> {
    const historyDir = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      path.join(historyDir, "journal-session.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
    const client = new ClaudeAgentClient({ logger: createTestLogger() });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: "journal-session" },
      { cwd },
      { env: { CLAUDE_CONFIG_DIR: configDir } },
    );
    try {
      const items: AgentTimelineItem[] = [];
      for await (const event of session.streamHistory()) {
        if (event.type === "timeline") items.push(event.item);
      }
      return items;
    } finally {
      await session.close();
    }
  }

  test.each(["api-request-shape", "api-request", "api-request-blob", "future-journal-record"])(
    "ignores %s content while preserving the conversation and tool calls",
    async (type) => {
      const items = await replay([
        { type: "user", message: { role: "user", content: "Read package.json" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "read-1",
                name: "Read",
                input: { file_path: "package.json" },
              },
            ],
          },
        },
        ...["user", "system", "assistant"].map((role) => ({
          type,
          message: {
            role,
            content: [
              {
                type: "text",
                text: "SessionStart hook output\n# MCP Server Instructions\n<total_tokens>1000 tokens left</total_tokens>",
              },
              {
                type: "tool_addition",
                tool: {
                  name: "deferred_tool",
                  description: "Deferred tool",
                  input_schema: { type: "object", properties: {} },
                },
              },
              {
                type: "tool_use",
                id: "journal-only",
                name: "Read",
                input: { file_path: "old.json" },
              },
            ],
          },
        })),
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "paseo" }] },
        },
      ]);

      expect(items).toEqual([
        expect.objectContaining({ type: "user_message", text: "Read package.json" }),
        expect.objectContaining({ type: "tool_call", callId: "read-1", name: "Read" }),
        expect.objectContaining({ type: "assistant_message", text: "paseo" }),
      ]);
    },
  );

  test("preserves system compaction and background task notifications", async () => {
    const items = await replay([
      {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual", preTokens: 1000 },
      },
      {
        type: "system",
        subtype: "task_notification",
        uuid: "note-1",
        task_id: "task-1",
        status: "completed",
        summary: "Background work finished",
      },
    ]);
    expect(items).toEqual([
      expect.objectContaining({
        type: "compaction",
        status: "completed",
        trigger: "manual",
        preTokens: 1000,
      }),
      expect.objectContaining({
        type: "tool_call",
        name: "task_notification",
        status: "completed",
      }),
    ]);
  });
});
