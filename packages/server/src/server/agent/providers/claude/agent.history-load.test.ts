import fs, { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { withClaudeReplayHistory } from "./transcript-history.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import type { ClaudeQueryFactory } from "./query.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";

/**
 * A resumed Claude agent whose transcript is missing or unreadable opens with an empty timeline.
 * The daemon log at its default level has to say which, and where it looked.
 */

const SESSION_ID = "history-load-session";

interface LogRecord {
  level: number;
  msg: string;
  sessionId?: string;
  historyPath?: string;
  err?: { message?: string };
}

describe("ClaudeAgentSession persisted history load", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let records: LogRecord[];

  async function resume(queryFactory?: ClaudeQueryFactory): Promise<AgentSession> {
    const client = new ClaudeAgentClient({
      logger: pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) }),
      queryFactory:
        queryFactory ??
        (() => {
          throw new Error("history load must not start a query");
        }),
      resolveBinary: async () => process.execPath,
      resolveVersion: async () => "2.1.220",
    });
    return client.resumeSession({ provider: "claude", sessionId: SESSION_ID }, { cwd });
  }

  function transcriptPath(): string {
    return path.join(claudeProjectDirSync(cwd, { configDir }), `${SESSION_ID}.jsonl`);
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-history-load-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    records = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test.each(["file_path", "files"])(
    "replays %s without probing targets and preserves live existence checks",
    async (field) => {
      const existingPath = path.join(cwd, "existing.txt");
      const missingPath = path.join(cwd, "missing.txt");
      writeFileSync(existingPath, "existing");
      const targets = [existingPath, missingPath];
      const inputs = targets.map((target) => ({
        [field]: field === "files" ? [target] : target,
      }));
      const toolBlocks = inputs.map((input, index) => ({
        type: "tool_use",
        id: `change-${index}`,
        name: "FileChange",
        input,
      }));
      const resultBlocks = toolBlocks.map((block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: "done",
      }));
      const transcript = [
        { type: "user", message: { content: "Change files" } },
        { type: "assistant", message: { content: toolBlocks } },
        { type: "user", message: { content: resultBlocks } },
        { type: "assistant", message: { content: "Finished" } },
      ];
      mkdirSync(path.dirname(transcriptPath()), { recursive: true });
      writeFileSync(transcriptPath(), transcript.map((entry) => JSON.stringify(entry)).join("\n"));

      // Observe the real filesystem calls; neither existing nor missing targets are mocked.
      const exists = vi.spyOn(fs, "existsSync");
      const liveMessages = [
        { type: "assistant", message: { content: toolBlocks } },
        { type: "user", message: { content: resultBlocks } },
        { type: "result", subtype: "success", total_cost_usd: 0 },
      ];
      const queryFactory = vi.fn();
      queryFactory.mockReturnValue({
        async next() {
          const value = liveMessages.shift();
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        close() {},
        async return() {
          return { done: true, value: undefined };
        },
        async supportedCommands() {
          return [];
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      });
      const session = await resume(queryFactory);
      try {
        const history: AgentStreamEvent[] = [];
        for await (const event of session.streamHistory()) history.push(event);
        expect(exists.mock.calls.filter(([target]) => targets.includes(String(target)))).toEqual(
          [],
        );
        const running = inputs.map((input, index) => ({
          type: "tool_call",
          callId: `change-${index}`,
          name: "FileChange",
          status: "running",
          error: null,
          detail: { type: "unknown", input, output: null },
        }));
        const completed = inputs.map((input, index) => ({
          type: "tool_call",
          callId: `change-${index}`,
          name: "FileChange",
          status: "completed",
          error: null,
          detail: {
            type: "unknown",
            input,
            output: {
              output: "done",
              files: [{ path: index === 0 ? "existing.txt" : "missing.txt", kind: "update" }],
            },
          },
        }));
        expect(history).toEqual(
          [
            { type: "user_message", text: "Change files" },
            ...running,
            ...completed,
            { type: "assistant_message", text: "Finished" },
          ].map((item) => ({ type: "timeline", provider: "claude", timestamp: undefined, item })),
        );

        exists.mockClear();
        const live = await collectSessionTurnEvents(session, "Change files again");
        expect(exists.mock.calls.filter(([target]) => targets.includes(String(target)))).toEqual([
          [existingPath],
          [missingPath],
        ]);
        const liveCompleted = live.flatMap((event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.status === "completed"
            ? [event.item]
            : [],
        );
        const missing = completed[1];
        expect(liveCompleted).toEqual([
          completed[0],
          {
            ...missing,
            detail: {
              ...missing.detail,
              output: { output: "done", files: [{ path: "missing.txt", kind: "add" }] },
            },
          },
        ]);
      } finally {
        await session.close();
      }
    },
  );

  test.each(["parent", "subagent"])(
    "replays %s Write and Edit calls without probing their targets",
    async (scope) => {
      const filePath = path.join(cwd, "unavailable", "file.txt");
      const content = ["Write", "Edit"].map((name) => ({
        type: "tool_use",
        id: name,
        name,
        input: { file_path: filePath },
      }));
      const entry = { type: "assistant", message: { content } };
      mkdirSync(path.dirname(transcriptPath()), { recursive: true });
      if (scope === "subagent") {
        const directory = path.join(path.dirname(transcriptPath()), SESSION_ID, "subagents");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          path.join(directory, "agent-child.meta.json"),
          JSON.stringify({ toolUseId: "task" }),
        );
        writeFileSync(
          path.join(directory, "agent-child.jsonl"),
          JSON.stringify({
            ...entry,
            isSidechain: true,
            agentId: "child",
          }),
        );
        writeFileSync(
          transcriptPath(),
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "task",
                  name: "Task",
                  input: { description: "Change files" },
                },
              ],
            },
          }),
        );
      } else {
        writeFileSync(transcriptPath(), JSON.stringify(entry));
      }

      const exists = vi.spyOn(fs, "existsSync");
      const session = await resume();
      try {
        const items = [];
        for await (const event of session.streamHistory()) {
          if (scope === "parent" && event.type === "timeline") items.push(event.item);
          if (event.type === "provider_subagent" && event.event.type === "timeline") {
            items.push(event.event.item);
          }
        }
        expect(exists.mock.calls.filter(([target]) => target === filePath)).toEqual([]);
        expect(items).toEqual([
          {
            type: "tool_call",
            callId: "Write",
            name: "Write",
            status: "running",
            error: null,
            detail: { type: "write", filePath },
          },
          {
            type: "tool_call",
            callId: "Edit",
            name: "Edit",
            status: "running",
            error: null,
            detail: { type: "edit", filePath },
          },
        ]);
      } finally {
        await session.close();
      }
    },
  );

  test("logs the resolved transcript path when the transcript does not exist", async () => {
    await (await resume()).close();

    expect(records).toContainEqual(
      expect.objectContaining({
        level: pino.levels.values.info,
        msg: "No Claude transcript to load history from",
        sessionId: SESSION_ID,
        historyPath: transcriptPath(),
      }),
    );
  });

  test("logs a warning with the error when the transcript cannot be read", async () => {
    // A directory at the transcript path exists but cannot be read as a file.
    mkdirSync(transcriptPath(), { recursive: true });

    await (await resume()).close();

    expect(records).toContainEqual(
      expect.objectContaining({
        level: pino.levels.values.warn,
        msg: "Failed to load Claude history from transcript",
        sessionId: SESSION_ID,
        historyPath: transcriptPath(),
        err: expect.objectContaining({ message: expect.stringContaining("EISDIR") }),
      }),
    );
  });

  test("loads readable history when the temporary directory is unavailable", () => {
    const file = transcriptPath();
    const entry = { type: "assistant", message: { content: [{ type: "text", text: "saved" }] } };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(entry));
    const unavailable = path.join(tempRoot, "unavailable-tmp");
    for (const variable of ["TMPDIR", "TEMP", "TMP"]) vi.stubEnv(variable, unavailable);
    withClaudeReplayHistory(file, (history) => {
      expect([...history.parentEntries]).toEqual([entry]);
    });
  });

  test.each(["parent", "child", "workflow"])(
    "preserves indexed %s history when its transcript disappears between passes",
    (target) => {
      const parent = transcriptPath();
      const sessionDirectory = parent.slice(0, -".jsonl".length);
      const child = path.join(sessionDirectory, "subagents", "agent-child.jsonl");
      const workflow = path.join(
        sessionDirectory,
        "subagents",
        "workflows",
        "wf_test",
        "agent-child.jsonl",
      );
      const parentEntry = {
        type: "assistant",
        message: { content: [{ type: "text", text: "parent" }] },
      };
      const childEntry = { ...parentEntry, isSidechain: true, agentId: "child" };
      mkdirSync(path.dirname(workflow), { recursive: true });
      writeFileSync(parent, JSON.stringify(parentEntry));
      writeFileSync(child, JSON.stringify(childEntry));
      writeFileSync(workflow, JSON.stringify(childEntry));
      withClaudeReplayHistory(parent, (history) => {
        rmSync({ parent, child, workflow }[target]);
        // Ownership facts and visible payloads are separate passes over the same source.
        for (let pass = 0; pass < 2; pass++) {
          expect([...history.parentEntries]).toEqual([parentEntry]);
          expect(history.subagents).toHaveLength(1);
          expect([...history.subagents[0]!.entries]).toEqual([childEntry]);
          expect([...history.workflowEntriesByRunId.get("wf_test")!]).toEqual([childEntry]);
        }
      });
    },
  );

  // chmod does not remove read access on Windows, or for root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "logs a warning with the error when Claude's project folders cannot be listed",
    async () => {
      // The transcript is not under cwd's folder, so the lookup lists the other project folders.
      mkdirSync(path.join(configDir, "projects"), { recursive: true });
      chmodSync(path.join(configDir, "projects"), 0o000);

      try {
        await (await resume()).close();
      } finally {
        chmodSync(path.join(configDir, "projects"), 0o755);
      }

      expect(records).toContainEqual(
        expect.objectContaining({
          level: pino.levels.values.warn,
          msg: "Failed to load Claude history from transcript",
          sessionId: SESSION_ID,
          err: expect.objectContaining({ message: expect.stringContaining("EACCES") }),
        }),
      );
    },
  );
});
