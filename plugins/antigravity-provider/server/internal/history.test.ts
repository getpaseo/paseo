import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listAntigravitySessions,
  readAntigravityTranscript,
  getAntigravitySessionTitle,
  normalizePath,
  resolveAntigravityRoot,
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
        // No primary_workspace_path or workspace: must not be offered
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
      // Real agy JSONL format with workspace, conversationId, display, timestamp (ms)
      {
        conversationId: "conv-real-jsonl",
        display: "Real agy interactive task",
        workspace: "/workspace/backend",
        timestamp: 1789509896806,
      },
    ];

    await writeFile(historyJsonl, records.map((r) => JSON.stringify(r)).join("\n"));

    // 1. List all excludes records without verified workspace
    const all = listAntigravitySessions(undefined, tempDir);
    expect(all).toHaveLength(4);
    expect(all.map((s) => s.persistence.data.conversationId)).not.toContain("conv-unverified");
    expect(all.find((s) => s.persistence.data.conversationId === "conv-real-jsonl")).toMatchObject({
      title: "Real agy interactive task",
      cwd: "/workspace/backend",
    });

    // 2. Filter by cwd
    const backendOnly = listAntigravitySessions({ cwd: "/workspace/backend" }, tempDir);
    expect(backendOnly).toHaveLength(3);
    expect(backendOnly.map((s) => s.persistence.data.conversationId)).toEqual([
      "conv-real-jsonl",
      "conv-3",
      "conv-2",
    ]);

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
    expect(limited[0].persistence.data.conversationId).toBe("conv-real-jsonl");

    // 6. Title lookup from history.jsonl
    expect(getAntigravitySessionTitle("conv-1", tempDir)).toBe("Frontend refactoring");
    expect(getAntigravitySessionTitle("conv-real-jsonl", tempDir)).toBe(
      "Real agy interactive task",
    );
  });

  it("lists sessions from real conversation_summaries.db schema with workspace URIs, date sorting, and preview fallback", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require("node:sqlite") as {
      DatabaseSync?: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };
    if (!sqlite.DatabaseSync) return;

    const dbPath = path.join(tempDir, "conversation_summaries.db");
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          step_count INTEGER NOT NULL DEFAULT 0,
          last_modified_time DATETIME NOT NULL,
          workspace_uris TEXT NOT NULL,
          last_user_input_time DATETIME NOT NULL
        );
      `);

      const stmt = db.prepare(`
        INSERT INTO conversation_summaries (
          conversation_id, title, preview, last_modified_time, last_user_input_time, workspace_uris
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      // Entry 1: project A, explicit title, newer user input time
      stmt.run(
        "conv-db-1",
        "Pipeline Game Automation",
        "Detailed preview text",
        "2026-10-29 05:45:00.123456+00:00",
        "2026-10-31 10:00:00.654321+00:00",
        JSON.stringify(["file:///workspace/project-a"]),
      );

      // Entry 2: project A, empty title (should fallback to preview), earlier timestamp
      stmt.run(
        "conv-db-2",
        "",
        "Fix memory leak in websocket",
        "2026-10-25 12:00:00.100+00:00",
        "2026-10-25 12:00:00.100+00:00",
        JSON.stringify(["file:///workspace/project-a"]),
      );

      // Entry 3: project B, different workspace
      stmt.run(
        "conv-db-3",
        "Backend API endpoints",
        "API docs",
        "2026-10-30 08:00:00.000+00:00",
        "2026-10-30 08:00:00.000+00:00",
        JSON.stringify(["file:///workspace/project-b"]),
      );

      // Entry 4: zero/sentinel timestamp row (e.g. 0001-01-01), should sort to bottom
      stmt.run(
        "conv-db-zero",
        "Ancient session",
        "Preview ancient",
        "0001-01-01 00:00:00+00:00",
        "0001-01-01 00:00:00+00:00",
        JSON.stringify(["file:///workspace/project-a"]),
      );

      // Entry 5: empty workspace_uris, must be excluded
      stmt.run(
        "conv-db-no-ws",
        "No workspace session",
        "Preview",
        "2026-10-31 11:00:00.000+00:00",
        "2026-10-31 11:00:00.000+00:00",
        "[]",
      );
    } finally {
      db.close();
    }

    // 1. List all valid sessions
    const all = listAntigravitySessions(undefined, tempDir);
    expect(all).toHaveLength(4);
    expect(all.map((s) => s.persistence.data.conversationId)).toEqual([
      "conv-db-1",
      "conv-db-3",
      "conv-db-2",
      "conv-db-zero",
    ]);

    // conv-db-2 has empty title, falls back to preview
    expect(all.find((s) => s.persistence.data.conversationId === "conv-db-2")?.title).toBe(
      "Fix memory leak in websocket",
    );

    // 2. Filter by cwd
    const projectA = listAntigravitySessions({ cwd: "/workspace/project-a" }, tempDir);
    expect(projectA).toHaveLength(3);
    expect(projectA.map((s) => s.persistence.data.conversationId)).toEqual([
      "conv-db-1",
      "conv-db-2",
      "conv-db-zero",
    ]);

    // 3. Filter by query
    const queried = listAntigravitySessions({ query: "Pipeline" }, tempDir);
    expect(queried).toHaveLength(1);
    expect(queried[0].title).toBe("Pipeline Game Automation");

    // 4. Title lookup
    expect(getAntigravitySessionTitle("conv-db-1", tempDir)).toBe("Pipeline Game Automation");
    expect(getAntigravitySessionTitle("conv-db-2", tempDir)).toBe("Fix memory leak in websocket");
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

  it("preserves case on POSIX filesystems while folding case on Windows", () => {
    const windowsPathA = "C:\\Workspace\\Project";
    const windowsPathB = "c:\\workspace\\project";
    expect(normalizePath(windowsPathA)).toBe(normalizePath(windowsPathB));

    const posixPathA = "/workspace/App";
    const posixPathB = "/workspace/app";
    if (process.platform === "win32") {
      expect(normalizePath(posixPathA)).toBe(normalizePath(posixPathB));
    } else {
      expect(normalizePath(posixPathA)).not.toBe(normalizePath(posixPathB));
      expect(normalizePath(posixPathA)).toBe("/workspace/App");
      expect(normalizePath(posixPathB)).toBe("/workspace/app");
    }
  });

  it("resolves antigravity root with effective launch and session environment overrides", () => {
    // 1. Explicit AGY_HOME in env
    expect(resolveAntigravityRoot(undefined, { AGY_HOME: "/custom/agy" })).toBe("/custom/agy");

    // 2. Custom HOME in env overrides daemon process.env.AGY_HOME
    const oldAgyHome = process.env.AGY_HOME;
    try {
      process.env.AGY_HOME = "/daemon/agy";
      const resolved = resolveAntigravityRoot(undefined, { HOME: "/account/user" });
      expect(resolved).toBe(path.join("/account/user", ".gemini", "antigravity-cli"));
    } finally {
      process.env.AGY_HOME = oldAgyHome;
    }

    // 3. Explicit baseDir takes precedence over everything
    expect(resolveAntigravityRoot("/base/override", { AGY_HOME: "/custom/agy" })).toBe(
      "/base/override",
    );
  });

  it("reads sessions, title, and transcript using effective environment overrides", async () => {
    const customHome = path.join(tempDir, "custom-user");
    const customAgy = path.join(customHome, ".gemini", "antigravity-cli");
    await mkdir(customAgy, { recursive: true });

    const historyJsonl = path.join(customAgy, "history.jsonl");
    const record = {
      conversationId: "conv-custom-env",
      display: "Custom Env Task",
      workspace: "/workspace/custom",
      timestamp: 1789509896806,
    };
    await writeFile(historyJsonl, JSON.stringify(record) + "\n");

    const logDir = path.join(customAgy, "brain", "conv-custom-env", ".system_generated", "logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(
      path.join(logDir, "transcript.jsonl"),
      JSON.stringify({ type: "USER_INPUT", content: "hello from custom env" }) + "\n",
    );

    // List with env.HOME pointing to custom home
    const sessions = listAntigravitySessions({ env: { HOME: customHome } });
    expect(sessions.some((s) => s.persistence.data.conversationId === "conv-custom-env")).toBe(
      true,
    );

    // Title lookup with env.HOME
    const title = getAntigravitySessionTitle("conv-custom-env", undefined, { HOME: customHome });
    expect(title).toBe("Custom Env Task");

    // Transcript read with env.HOME
    const turns = readAntigravityTranscript("conv-custom-env", undefined, { HOME: customHome });
    expect(turns).toHaveLength(1);
    expect(turns[0].items[0]).toMatchObject({
      type: "user_message",
      text: "hello from custom env",
    });
  });
});
