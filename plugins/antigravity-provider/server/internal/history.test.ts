import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { loadTranscriptHistory, resolveAntigravityAppDataDir } from "./history.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "antigravity-history-test-"));
  temporary.push(dir);
  return dir;
}

async function writeTranscript(
  appDataDir: string,
  conversationId: string,
  filename: "transcript_full.jsonl" | "transcript.jsonl",
  lines: Array<string | Record<string, unknown>>,
): Promise<void> {
  const logsDir = path.join(appDataDir, "brain", conversationId, ".system_generated", "logs");
  await mkdir(logsDir, { recursive: true });
  const body = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  await writeFile(path.join(logsDir, filename), `${body}\n`, "utf8");
}

describe("resolveAntigravityAppDataDir", () => {
  it("prefers session env ANTIGRAVITY_APP_DATA_DIR over launch env and HOME", () => {
    expect(
      resolveAntigravityAppDataDir(
        { ANTIGRAVITY_APP_DATA_DIR: "/launch/agy", HOME: "/launch/home" },
        { ANTIGRAVITY_APP_DATA_DIR: " /session/agy ", HOME: "/session/home" },
      ),
    ).toBe("/session/agy");
  });

  it("ignores host process.env and falls back to HOME/.gemini/antigravity-cli", () => {
    const previous = process.env.ANTIGRAVITY_APP_DATA_DIR;
    process.env.ANTIGRAVITY_APP_DATA_DIR = "/host/should-ignore";
    try {
      expect(
        resolveAntigravityAppDataDir({ HOME: "/launch/home" }, { HOME: "/session/home" }),
      ).toBe(path.join("/session/home", ".gemini", "antigravity-cli"));
    } finally {
      if (previous === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR;
      else process.env.ANTIGRAVITY_APP_DATA_DIR = previous;
    }
  });
});

describe("loadTranscriptHistory", () => {
  it("prefers transcript_full.jsonl, unwraps USER_REQUEST, and pairs tools FIFO", async () => {
    const appDataDir = await makeTempDir();
    const conversationId = "conv-123";
    await writeTranscript(appDataDir, conversationId, "transcript.jsonl", [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-12T10:00:00Z",
        content: "<USER_REQUEST>\ntruncated fallback\n</USER_REQUEST>",
      },
    ]);
    await writeTranscript(appDataDir, conversationId, "transcript_full.jsonl", [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-12T09:59:59Z",
        content: "internal system message",
      },
      {
        step_index: 1,
        type: "USER_INPUT",
        created_at: "2026-11-12T10:00:00Z",
        content: [
          "<USER_REQUEST>",
          "SYSTEM PREFIX",
          "",
          "Check package.json",
          "</USER_REQUEST>",
          "<ADDITIONAL_METADATA>",
          "local time",
          "</ADDITIONAL_METADATA>",
        ].join("\n"),
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-12T10:00:02Z",
        thinking: "I should read the file and run tests.",
        content: "Let me inspect the repo first.",
        tool_calls: [
          { name: "read_file", args: { Path: "/repo/package.json" } },
          { name: "run_command", args: { CommandLine: "npm test" } },
        ],
      },
      {
        step_index: 3,
        type: "CHECKPOINT",
        created_at: "2026-11-12T10:00:02Z",
        content: "",
      },
      {
        step_index: 4,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-12T10:00:03Z",
        content: '{"name":"demo"}',
      },
      {
        step_index: 5,
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-12T10:00:04Z",
        error: "exit code 1",
        content: "FAIL",
      },
      {
        step_index: 6,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-12T10:00:05Z",
        content: "Tests failed with exit code 1.",
      },
      {
        step_index: 7,
        type: "USER_INPUT",
        created_at: "2026-11-12T10:01:00Z",
        content:
          "<USER_REQUEST>\nSYSTEM PREFIX\n\nSecond message keeps literal prefix\n</USER_REQUEST>",
      },
    ]);

    const replayed = await loadTranscriptHistory({
      conversationId,
      appDataDir,
      systemPrompt: "SYSTEM PREFIX",
    });

    for (const entry of replayed) {
      ProviderEventSchema.parse({
        type: "timeline.item",
        sessionId: "s",
        item: entry.item,
        timestamp: entry.timestamp,
      });
    }

    expect(replayed).toEqual([
      {
        item: { type: "user_message", id: "history:1:user", text: "Check package.json" },
        timestamp: "2026-11-12T10:00:00Z",
      },
      {
        item: {
          type: "reasoning",
          id: "history:2:reasoning",
          text: "I should read the file and run tests.",
        },
        timestamp: "2026-11-12T10:00:02Z",
      },
      {
        item: {
          type: "assistant_message",
          id: "history:2:assistant",
          text: "Let me inspect the repo first.",
        },
        timestamp: "2026-11-12T10:00:02Z",
      },
      {
        item: {
          type: "tool_call",
          id: "history:2:tool:0",
          callId: "history:2:tool:0",
          name: "read_file",
          detail: { type: "read", filePath: "/repo/package.json", content: '{"name":"demo"}' },
          status: "completed",
          error: null,
        },
        timestamp: "2026-11-12T10:00:03Z",
      },
      {
        item: {
          type: "tool_call",
          id: "history:2:tool:1",
          callId: "history:2:tool:1",
          name: "run_command",
          detail: { type: "shell", command: "npm test", output: "FAIL" },
          status: "failed",
          error: "exit code 1",
        },
        timestamp: "2026-11-12T10:00:04Z",
      },
      {
        item: {
          type: "assistant_message",
          id: "history:6:assistant",
          text: "Tests failed with exit code 1.",
        },
        timestamp: "2026-11-12T10:00:05Z",
      },
      {
        item: {
          type: "user_message",
          id: "history:7:user",
          text: "SYSTEM PREFIX\n\nSecond message keeps literal prefix",
        },
        timestamp: "2026-11-12T10:01:00Z",
      },
    ]);
  });

  it("falls back when transcript_full.jsonl is unreadable and maps write/edit/errors", async () => {
    const appDataDir = await makeTempDir();
    const conversationId = "conv-fallback";
    await writeTranscript(appDataDir, conversationId, "transcript.jsonl", [
      "{truncated json",
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-12T11:00:00Z",
        tool_calls: [
          { name: "write_file", args: { Path: "/repo/a.ts", Content: "export const a = 1;" } },
          { name: "edit_file", args: { Path: "/repo/b.ts", Target: "old", Replacement: "new" } },
          { name: "search_web", args: { query: "paseo" } },
          { name: "run_command", args: { CommandLine: "sleep 60" } },
        ],
      },
      { step_index: 1, type: "GENERIC", status: "DONE", content: "written" },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "edited" },
      { step_index: 3, type: "GENERIC", status: "DONE" },
      { step_index: 4, type: "GENERIC", status: "RUNNING", content: "partial" },
      {
        step_index: 5,
        type: "ERROR_MESSAGE",
        status: "DONE",
        error: "API error: stream idle timeout",
        content: "",
      },
    ]);
    await mkdir(
      path.join(
        appDataDir,
        "brain",
        conversationId,
        ".system_generated",
        "logs",
        "transcript_full.jsonl",
      ),
    );

    const replayed = await loadTranscriptHistory({ conversationId, appDataDir });

    for (const entry of replayed) {
      ProviderEventSchema.parse({
        type: "timeline.item",
        sessionId: "s",
        item: entry.item,
        timestamp: entry.timestamp,
      });
    }

    expect(replayed).toEqual([
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:0",
          callId: "history:0:tool:0",
          name: "write_file",
          detail: { type: "write", filePath: "/repo/a.ts", content: "export const a = 1;" },
          status: "completed",
          error: null,
        },
        timestamp: "2026-11-12T11:00:00Z",
      },
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:1",
          callId: "history:0:tool:1",
          name: "edit_file",
          detail: { type: "edit", filePath: "/repo/b.ts", oldString: "old", newString: "new" },
          status: "completed",
          error: null,
        },
        timestamp: "2026-11-12T11:00:00Z",
      },
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:2",
          callId: "history:0:tool:2",
          name: "search_web",
          detail: { type: "unknown", input: { query: "paseo" }, output: null },
          status: "completed",
          error: null,
        },
        timestamp: "2026-11-12T11:00:00Z",
      },
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:3",
          callId: "history:0:tool:3",
          name: "run_command",
          detail: { type: "shell", command: "sleep 60", output: "partial" },
          status: "canceled",
          error: null,
        },
        timestamp: "2026-11-12T11:00:00Z",
      },
      {
        item: {
          type: "error",
          id: "history:5:error",
          message: "API error: stream idle timeout",
        },
        timestamp: undefined,
      },
    ]);
  });

  it("preserves literal USER_REQUEST examples and normalizes non-finite JSON", async () => {
    const appDataDir = await makeTempDir();
    const conversationId = "conv-nested";
    const promptBody = [
      "Keep this example intact:",
      "<USER_REQUEST>",
      "inner",
      "</USER_REQUEST>",
      "<CUSTOM_BLOCK>still user text</CUSTOM_BLOCK>",
    ].join("\n");
    await writeTranscript(appDataDir, conversationId, "transcript_full.jsonl", [
      {
        step_index: 0,
        type: "USER_INPUT",
        content: [
          "<USER_REQUEST>",
          promptBody,
          "</USER_REQUEST>",
          "<ADDITIONAL_METADATA>",
          "time",
          "</ADDITIONAL_METADATA>",
        ].join("\n"),
      },
      [
        '{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[',
        '{"name":"custom_tool","args":{"num":1e400,"nested":[1,1e400],',
        '"__proto__":{"CommandLine":"echo nested"}}},',
        '{"name":"run_command","args":{"__proto__":{"CommandLine":"echo injected"}}}]}',
      ].join(""),
      { step_index: 2, type: "GENERIC", status: "DONE", content: "ok" },
      { step_index: 3, type: "GENERIC", status: "DONE", content: "ran" },
    ]);

    const replayed = await loadTranscriptHistory({ conversationId, appDataDir });
    expect(replayed).toEqual([
      {
        item: { type: "user_message", id: "history:0:user", text: promptBody },
        timestamp: undefined,
      },
      {
        item: {
          type: "tool_call",
          id: "history:1:tool:0",
          callId: "history:1:tool:0",
          name: "custom_tool",
          detail: {
            type: "unknown",
            input: JSON.parse(
              '{"num":null,"nested":[1,null],"__proto__":{"CommandLine":"echo nested"}}',
            ),
            output: "ok",
          },
          status: "completed",
          error: null,
        },
        timestamp: undefined,
      },
      {
        item: {
          type: "tool_call",
          id: "history:1:tool:1",
          callId: "history:1:tool:1",
          name: "run_command",
          detail: {
            type: "unknown",
            input: JSON.parse('{"__proto__":{"CommandLine":"echo injected"}}'),
            output: "ran",
          },
          status: "completed",
          error: null,
        },
        timestamp: undefined,
      },
    ]);
  });

  it("cancels unpaired tools on interruption or EOF and returns [] for invalid ids", async () => {
    const appDataDir = await makeTempDir();
    await writeTranscript(appDataDir, "conv-unpaired", "transcript_full.jsonl", [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "read_file", args: { Path: "/repo/x.ts" } }],
      },
      {
        step_index: 1,
        type: "USER_INPUT",
        content: "<USER_REQUEST>\nCancel that\n</USER_REQUEST>",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "echo hi" } }],
      },
    ]);

    expect(
      await loadTranscriptHistory({ conversationId: "conv-unpaired", appDataDir }),
    ).toEqual([
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:0",
          callId: "history:0:tool:0",
          name: "read_file",
          detail: { type: "read", filePath: "/repo/x.ts" },
          status: "canceled",
          error: null,
        },
        timestamp: undefined,
      },
      {
        item: { type: "user_message", id: "history:1:user", text: "Cancel that" },
        timestamp: undefined,
      },
      {
        item: {
          type: "tool_call",
          id: "history:2:tool:0",
          callId: "history:2:tool:0",
          name: "run_command",
          detail: { type: "shell", command: "echo hi" },
          status: "canceled",
          error: null,
        },
        timestamp: undefined,
      },
    ]);

    expect(
      await loadTranscriptHistory({ conversationId: "does-not-exist", appDataDir }),
    ).toEqual([]);
    expect(await loadTranscriptHistory({ conversationId: "../escape", appDataDir })).toEqual([]);
    expect(await loadTranscriptHistory({ conversationId: "conv:ads", appDataDir })).toEqual([]);
  });

  it("settles RUNNING/INTERRUPTED tools, agy write/edit fields, and 0-byte fallback", async () => {
    const appDataDir = await makeTempDir();
    const emptyLogsDir = path.join(appDataDir, "brain", "conv-empty", ".system_generated", "logs");
    await mkdir(emptyLogsDir, { recursive: true });
    await writeFile(path.join(emptyLogsDir, "transcript_full.jsonl"), "", "utf8");
    await writeTranscript(appDataDir, "conv-empty", "transcript.jsonl", [
      {
        step_index: 0,
        type: "USER_INPUT",
        content: "<USER_REQUEST>\nFrom compact fallback\n</USER_REQUEST>",
      },
    ]);
    expect(await loadTranscriptHistory({ conversationId: "conv-empty", appDataDir })).toEqual([
      {
        item: { type: "user_message", id: "history:0:user", text: "From compact fallback" },
        timestamp: undefined,
      },
    ]);

    await writeTranscript(appDataDir, "conv-bg", "transcript_full.jsonl", [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "npm test" } },
          {
            name: "write_to_file",
            args: {
              AbsolutePath: "",
              TargetFile: "/repo/a.ts",
              CodeContent: "export const a = 1;",
            },
          },
          {
            name: "replace_file_content",
            args: {
              TargetFile: "/repo/b.ts",
              TargetContent: "old",
              ReplacementContent: "new",
            },
          },
          { name: "read_file", args: { Path: "/repo/c.ts" } },
        ],
      },
      { step_index: 1, type: "GENERIC", status: "RUNNING", content: "background task" },
      { step_index: 2, type: "GENERIC", status: "INTERRUPTED" },
      { step_index: 3, type: "GENERIC", status: "HALTED" },
      { step_index: 4, type: "GENERIC", status: "DONE", content: "file c" },
      { step_index: 5, type: "PLANNER_RESPONSE", content: "Done." },
      {
        step_index: 6,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { CommandLine: "sleep 30" } }],
      },
      { step_index: 7, type: "GENERIC", status: "RUNNING", content: "aborted at EOF" },
    ]);

    expect(await loadTranscriptHistory({ conversationId: "conv-bg", appDataDir })).toEqual([
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:0",
          callId: "history:0:tool:0",
          name: "run_command",
          detail: { type: "shell", command: "npm test", output: "background task" },
          status: "completed",
          error: null,
        },
        timestamp: undefined,
      },
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:1",
          callId: "history:0:tool:1",
          name: "write_to_file",
          detail: { type: "write", filePath: "/repo/a.ts", content: "export const a = 1;" },
          status: "canceled",
          error: null,
        },
        timestamp: undefined,
      },
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:2",
          callId: "history:0:tool:2",
          name: "replace_file_content",
          detail: { type: "edit", filePath: "/repo/b.ts", oldString: "old", newString: "new" },
          status: "canceled",
          error: null,
        },
        timestamp: undefined,
      },
      {
        item: {
          type: "tool_call",
          id: "history:0:tool:3",
          callId: "history:0:tool:3",
          name: "read_file",
          detail: { type: "read", filePath: "/repo/c.ts", content: "file c" },
          status: "completed",
          error: null,
        },
        timestamp: undefined,
      },
      {
        item: { type: "assistant_message", id: "history:5:assistant", text: "Done." },
        timestamp: undefined,
      },
      {
        item: {
          type: "tool_call",
          id: "history:6:tool:0",
          callId: "history:6:tool:0",
          name: "run_command",
          detail: { type: "shell", command: "sleep 30", output: "aborted at EOF" },
          status: "canceled",
          error: null,
        },
        timestamp: undefined,
      },
    ]);
  });
});
