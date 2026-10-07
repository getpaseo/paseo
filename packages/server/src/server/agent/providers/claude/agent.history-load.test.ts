import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { withClaudeReplayHistory } from "./transcript-history.js";

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

  async function resume(): Promise<void> {
    const client = new ClaudeAgentClient({
      logger: pino({ level: "info" }, { write: (line: string) => records.push(JSON.parse(line)) }),
      queryFactory: vi.fn(() => {
        throw new Error("history load must not start a query");
      }),
      resolveVersion: async () => "2.1.220",
    });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    await session.close();
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
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("logs the resolved transcript path when the transcript does not exist", async () => {
    await resume();

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

    await resume();

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
});
