import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { AgentManager } from "../../agent-manager.js";
import { AgentStorage } from "../../agent-storage.js";
import { ensureAgentLoaded } from "../../agent-loading.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
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

  test.each([
    { status: "turn_completed", outcome: "completed" },
    { status: "turn_failed", outcome: "Error: resumed provider failure" },
  ] as const)(
    "records a distinct $status timing when the same agent runs after disk reload",
    async ({ status, outcome }) => {
      const logger = createTestLogger();
      const storagePath = path.join(tempRoot, "agents");
      const storage = new AgentStorage(storagePath, logger);
      function assistantFrame(generation: number) {
        return {
          type: "assistant",
          uuid: `transcript-reply-${generation}`,
          session_id: SESSION_ID,
          message: {
            id: `provider-reply-${generation}`,
            role: "assistant",
            content: [{ type: "text", text: "same reply" }],
          },
        };
      }
      async function* sdkMessages(generation: number) {
        yield { type: "system", subtype: "init", session_id: SESSION_ID };
        yield assistantFrame(generation);
        const failed = generation === 1 && status === "turn_failed";
        const subtype = failed ? "error_during_execution" : "success";
        yield {
          type: "result",
          subtype,
          session_id: SESSION_ID,
          errors: ["resumed provider failure"],
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        };
      }
      let generation = 0;
      const queryFactory = vi.fn().mockImplementation(() =>
        Object.assign(sdkMessages(generation++), {
          close: () => undefined,
          supportedModels: async () => [],
          supportedCommands: async () => [],
          applyFlagSettings: async () => undefined,
        }),
      );
      const client = new ClaudeAgentClient({
        logger,
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
      });
      const manager = new AgentManager({ clients: { claude: client }, registry: storage, logger });
      const reloadedStorage = new AgentStorage(storagePath, logger);
      const reloaded = new AgentManager({
        clients: { claude: client },
        registry: reloadedStorage,
        logger,
      });
      let agentId: string | undefined;
      try {
        const agent = await manager.createAgent({ provider: "claude", cwd }, undefined, {
          workspaceId: undefined,
        });
        agentId = agent.id;
        await manager.runAgent(agent.id, "first prompt");
        await manager.flush();
        const firstTiming = (await storage.get(agent.id))!.turnTimings![0]!;
        expect(firstTiming).toMatchObject({
          status: "turn_completed",
          messageIds: ["provider-reply-0"],
        });
        mkdirSync(path.dirname(transcriptPath()), { recursive: true });
        writeFileSync(transcriptPath(), JSON.stringify(assistantFrame(0)));
        await manager.closeAgent(agent.id);
        await manager.flush();
        await ensureAgentLoaded(agent.id, {
          agentManager: reloaded,
          agentStorage: reloadedStorage,
          logger,
        });
        expect((await reloadedStorage.get(agent.id))!.turnTimings).toEqual([firstTiming]);
        const completed = await reloaded.runAgent(agent.id, "second prompt").then(
          () => "completed",
          (error: unknown) => String(error),
        );
        expect(completed).toBe(outcome);
        await reloaded.flush();
        const timeline = reloaded.fetchTimeline(agent.id, { direction: "tail", limit: 0 });
        const reply = timeline.rows.find(
          (row) =>
            row.item.type === "assistant_message" && row.item.messageId === "provider-reply-1",
        )!;
        expect(reply.item).toEqual({
          type: "assistant_message",
          text: "same reply",
          messageId: "provider-reply-1",
        });
        const currentPage = reloaded.fetchTimeline(agent.id, {
          direction: "after",
          cursor: { epoch: timeline.epoch, seq: reply.seqStart - 1 },
          limit: 1,
        });
        const diskStorage = new AgentStorage(storagePath, logger);
        const currentTimings = await diskStorage.getTurnTimings({
          agentId: agent.id,
          turnIds: new Set([reply.turnId!]),
          messageIds: new Set(["provider-reply-1"]),
        });
        expect(currentPage.rows).toEqual([reply]);
        expect(currentTimings).toMatchObject([{ status, messageIds: ["provider-reply-1"] }]);
        const timings = (await diskStorage.get(agent.id))!.turnTimings!;
        expect(timings).toHaveLength(2);
        expect(timings[0]).toEqual(firstTiming);
        expect(timings[1]!.turnId).not.toBe(firstTiming.turnId);
        expect(timings[1]!.turnId).toBe(reply.turnId);
        expect(currentTimings).toEqual([timings[1]]);
        const historyPage = reloaded.fetchTimeline(agent.id, {
          direction: "after",
          cursor: { epoch: timeline.epoch, seq: 0 },
          limit: 1,
        });
        expect(historyPage.rows[0]!.item).toEqual({
          type: "assistant_message",
          text: "same reply",
          messageId: "provider-reply-0",
        });
        expect(historyPage.rows[0]!.turnId).toBeUndefined();
        expect(
          await diskStorage.getTurnTimings({
            agentId: agent.id,
            turnIds: new Set(),
            messageIds: new Set(["provider-reply-0"]),
          }),
        ).toEqual([firstTiming]);
        expect(queryFactory).toHaveBeenCalledTimes(2);
      } finally {
        if (agentId) {
          await manager.closeAgent(agentId);
          await reloaded.closeAgent(agentId);
        }
        await manager.flush();
        await reloaded.flush();
      }
    },
  );

  test("reloads live foreground and autonomous timings with distinct transcript IDs", async () => {
    const logger = createTestLogger();
    const storagePath = path.join(tempRoot, "agents");
    const storage = new AgentStorage(storagePath, logger);
    let releaseAutonomous!: () => void;
    const autonomous = new Promise<void>((resolve) => {
      releaseAutonomous = resolve;
    });
    let releaseQuery!: () => void;
    const closed = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const replies = ["foreground", "autonomous"].map((owner) => ({
      type: "assistant",
      uuid: `transcript-${owner}`,
      session_id: SESSION_ID,
      timestamp: "2026-10-15T08:00:00.000Z",
      message: {
        id: `provider-${owner}`,
        role: "assistant",
        content: [{ type: "text", text: "identical reply" }],
      },
    }));
    async function* sdkMessages() {
      for (const reply of replies) {
        yield { type: "system", subtype: "init", session_id: SESSION_ID };
        yield {
          type: "stream_event",
          session_id: SESSION_ID,
          event: { type: "message_start", message: { id: reply.message.id } },
        };
        yield {
          type: "stream_event",
          session_id: SESSION_ID,
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "identical reply" },
          },
        };
        yield reply;
        yield {
          type: "result",
          subtype: "success",
          session_id: SESSION_ID,
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        };
        await autonomous;
      }
      await closed;
    }
    const queryFactory = vi.fn().mockImplementation(() =>
      Object.assign(sdkMessages(), {
        close: releaseQuery,
        supportedModels: async () => [],
        supportedCommands: async () => [],
        applyFlagSettings: async () => undefined,
      }),
    );
    function client() {
      return new ClaudeAgentClient({
        logger,
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
        resolveVersion: async () => "2.1.220",
      });
    }
    const manager = new AgentManager({ clients: { claude: client() }, registry: storage, logger });
    const reloadedStorage = new AgentStorage(storagePath, logger);
    const reloaded = new AgentManager({
      clients: { claude: client() },
      registry: reloadedStorage,
      logger,
    });
    let agentId: string | undefined;
    try {
      const agent = await manager.createAgent({ provider: "claude", cwd }, undefined, {
        workspaceId: undefined,
      });
      agentId = agent.id;
      await manager.runAgent(agent.id, "prompt");
      releaseAutonomous();
      await vi.waitFor(async () => {
        expect((await storage.get(agent.id))?.turnTimings).toHaveLength(2);
      });
      await manager.flush();
      const timings = (await storage.get(agent.id))!.turnTimings!;
      expect(timings.map((timing) => timing.messageIds)).toEqual([
        ["provider-foreground"],
        ["provider-autonomous"],
      ]);
      expect(timings.map((timing) => timing.turnId)).toEqual([
        expect.stringMatching(/^foreground-turn-/),
        expect.stringMatching(/^autonomous-turn-/),
      ]);
      mkdirSync(path.dirname(transcriptPath()), { recursive: true });
      const history = replies.toReversed();
      writeFileSync(transcriptPath(), history.map((reply) => JSON.stringify(reply)).join("\n"));
      releaseQuery();
      await manager.closeAgent(agent.id);
      await manager.flush();
      const record = (await reloadedStorage.get(agent.id))!;
      expect(record.turnTimings).toEqual(timings);
      await ensureAgentLoaded(agent.id, {
        agentManager: reloaded,
        agentStorage: reloadedStorage,
        logger,
      });
      const tail = reloaded.fetchTimeline(agent.id, { direction: "tail", limit: 1 });
      expect(tail.rows[0]!.turnId).toBeUndefined();
      expect(tail.hasOlder).toBe(true);
      const older = reloaded.fetchTimeline(agent.id, {
        direction: "before",
        cursor: { epoch: tail.epoch, seq: tail.startSeq! },
        limit: 1,
      });
      const after = reloaded.fetchTimeline(agent.id, {
        direction: "after",
        cursor: { epoch: tail.epoch, seq: tail.endSeq! },
        limit: 1,
      });
      for (const [page, expected] of [
        [tail, [timings[0]]],
        [older, [timings[1]]],
        [after, []],
      ] as const) {
        const messageIds = new Set<string>();
        for (const row of page.rows) {
          expect(row.turnId).toBeUndefined();
          if (row.item.type === "assistant_message" && row.item.messageId) {
            messageIds.add(row.item.messageId);
          }
        }
        expect(
          await reloadedStorage.getTurnTimings({
            agentId: agent.id,
            turnIds: new Set(),
            messageIds,
          }),
        ).toEqual(expected);
      }
      expect(tail.rows.map((row) => row.item)).toEqual([
        { type: "assistant_message", text: "identical reply", messageId: "provider-foreground" },
      ]);
      expect(queryFactory).toHaveBeenCalledTimes(1);
    } finally {
      releaseAutonomous();
      releaseQuery();
      if (agentId) {
        await manager.closeAgent(agentId);
        await reloaded.closeAgent(agentId);
      }
      await manager.flush();
      await reloaded.flush();
    }
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

  // chmod does not remove read access on Windows, or for root.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "logs a warning with the error when Claude's project folders cannot be listed",
    async () => {
      // The transcript is not under cwd's folder, so the lookup lists the other project folders.
      mkdirSync(path.join(configDir, "projects"), { recursive: true });
      chmodSync(path.join(configDir, "projects"), 0o000);

      try {
        await resume();
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
