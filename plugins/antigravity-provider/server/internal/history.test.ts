import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listAntigravitySessions,
  readAntigravityTranscript,
  getAntigravitySessionTitle,
} from "./history.js";
import { mapHistoryToolDetail } from "./timeline.js";

describe("history utilities", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-history-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("maps tool calls to appropriate ProviderToolCallDetail", () => {
    expect(mapHistoryToolDetail("run_command", { CommandLine: "ls -la" }, "output text")).toEqual({
      type: "shell",
      command: "ls -la",
      output: "output text",
    });

    expect(mapHistoryToolDetail("view_file", { AbsolutePath: "/foo/bar.txt" }, "content")).toEqual({
      type: "read",
      filePath: "/foo/bar.txt",
      content: "content",
    });

    expect(mapHistoryToolDetail("write_to_file", { TargetFile: "/foo/baz.ts" })).toEqual({
      type: "write",
      filePath: "/foo/baz.ts",
    });

    expect(mapHistoryToolDetail("replace_file_content", { TargetFile: "/foo/baz.ts" })).toEqual({
      type: "edit",
      filePath: "/foo/baz.ts",
    });

    expect(mapHistoryToolDetail("custom_unknown_tool", { foo: "bar" })).toEqual({
      type: "unknown",
      input: { foo: "bar" },
      output: null,
    });
  });

  it("lists sessions from isolated history.jsonl with workspace and query filters", async () => {
    const historyJsonl = path.join(tempDir, "history.jsonl");
    const records = [
      {
        conversation_id: "conv-unverified",
        title: "Session without workspace",
        // No primary_workspace_path: must not be offered
        updated_at: "2026-10-15T09:00:00Z",
      },
      {
        conversation_id: "conv-1",
        title: "Frontend refactoring",
        primary_workspace_path: "/workspace/frontend",
        updated_at: "2026-10-15T10:00:00Z",
      },
      {
        conversation_id: "conv-2",
        title: "Backend API endpoints",
        primary_workspace_path: "/workspace/backend",
        updated_at: "2026-10-15T11:00:00Z",
      },
      {
        conversation_id: "conv-3",
        title: "Database schema migration",
        primary_workspace_path: "/workspace/backend",
        updated_at: "2026-10-15T12:00:00Z",
      },
    ];

    await writeFile(historyJsonl, records.map((r) => JSON.stringify(r)).join("\n"));

    // 1. List all excludes records without verified workspace
    const all = listAntigravitySessions(undefined, tempDir);
    expect(all).toHaveLength(3);
    expect(all[0].persistence.data.conversationId).toBe("conv-3");
    expect(all.map((s) => s.persistence.data.conversationId)).not.toContain("conv-unverified");

    // 2. Filter by cwd
    const backendOnly = listAntigravitySessions({ cwd: "/workspace/backend" }, tempDir);
    expect(backendOnly).toHaveLength(2);
    expect(backendOnly.map((s) => s.persistence.data.conversationId)).toEqual(["conv-3", "conv-2"]);

    // 3. Filter by cwd with 0 matches returns empty array
    const noMatches = listAntigravitySessions({ cwd: "/workspace/nonexistent" }, tempDir);
    expect(noMatches).toEqual([]);

    // 4. Filter by query
    const queryResult = listAntigravitySessions({ query: "refactoring" }, tempDir);
    expect(queryResult).toHaveLength(1);
    expect(queryResult[0].title).toBe("Frontend refactoring");

    // 5. Limit
    const limited = listAntigravitySessions({ limit: 1 }, tempDir);
    expect(limited).toHaveLength(1);
    expect(limited[0].persistence.data.conversationId).toBe("conv-3");

    // 6. Title lookup from history.jsonl
    expect(getAntigravitySessionTitle("conv-1", tempDir)).toBe("Frontend refactoring");
  });

  it("recovers valid turns from transcripts containing corrupted or null records", async () => {
    const convId = "conv-corrupt-test";
    const logDir = path.join(tempDir, "brain", convId, ".system_generated", "logs");
    await mkdir(logDir, { recursive: true });
    const transcriptPath = path.join(logDir, "transcript_full.jsonl");

    const lines = [
      // Turn 1
      JSON.stringify({
        type: "USER_INPUT",
        content: "<USER_REQUEST>Fix memory leak in websocket</USER_REQUEST>",
      }),
      // Corrupt line 1: literal null
      "null",
      // Corrupt line 2: non-object
      "42",
      // Planner response with tool calls and corrupted items
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        step_index: 1,
        thinking: "Need to profile memory usage",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "node --inspect app.js" } },
          null, // corrupt tool call
          { name: "view_file", args: { AbsolutePath: "/src/ws.ts" } },
        ],
        content: "I started profiling the websocket connection.",
        input_tokens: 1500,
        output_tokens: 200,
      }),
      // Turn 2
      JSON.stringify({
        type: "USER_INPUT",
        content: "What did you find?",
      }),
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        step_index: 3,
        content: "Found an unclosed event listener.",
      }),
    ];

    await writeFile(transcriptPath, lines.join("\n"));

    const turns = readAntigravityTranscript(convId, tempDir);
    expect(turns).toHaveLength(2);

    // Turn 1 verification
    const turn1 = turns[0];
    expect(turn1.turnId).toBe("hist-turn-1");
    expect(turn1.items).toHaveLength(5);

    expect(turn1.items[0]).toMatchObject({
      type: "user_message",
      text: "Fix memory leak in websocket",
    });

    expect(turn1.items[1]).toMatchObject({
      type: "reasoning",
      text: "Need to profile memory usage",
    });

    expect(turn1.items[2]).toMatchObject({
      type: "tool_call",
      name: "run_command",
      detail: { type: "shell", command: "node --inspect app.js" },
      status: "completed",
    });

    expect(turn1.items[3]).toMatchObject({
      type: "tool_call",
      name: "view_file",
      detail: { type: "read", filePath: "/src/ws.ts" },
      status: "completed",
    });

    expect(turn1.items[4]).toMatchObject({
      type: "assistant_message",
      text: "I started profiling the websocket connection.",
    });

    expect(turn1.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 200,
      cachedInputTokens: 0,
    });

    // Turn 2 verification
    const turn2 = turns[1];
    expect(turn2.turnId).toBe("hist-turn-2");
    expect(turn2.items).toHaveLength(2);
    expect(turn2.items[0]).toMatchObject({
      type: "user_message",
      text: "What did you find?",
    });
    expect(turn2.items[1]).toMatchObject({
      type: "assistant_message",
      text: "Found an unclosed event listener.",
    });
  });

  it("handles non-existent conversation transcript gracefully", () => {
    const turns = readAntigravityTranscript("non-existent-conv-id-12345", tempDir);
    expect(turns).toEqual([]);
  });

  it("handles non-existent conversation title gracefully", () => {
    const title = getAntigravitySessionTitle("non-existent-conv-id-12345", tempDir);
    expect(title).toBeNull();
  });
});
