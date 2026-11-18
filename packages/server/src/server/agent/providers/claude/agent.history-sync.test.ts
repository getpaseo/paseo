import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import type { ClaudeQueryFactory } from "./query.js";

/**
 * Another Claude Code process (a terminal, the desktop app) can go on with a session a loaded
 * agent holds. Syncing reads only what it appended, and must give the same timeline a full
 * reload of the transcript would.
 */

const SESSION_ID = "history-sync-session";

describe("ClaudeAgentSession appended history sync", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  const sessions: AgentSession[] = [];

  function transcriptPath(): string {
    return path.join(claudeProjectDirSync(cwd, { configDir }), `${SESSION_ID}.jsonl`);
  }

  function lines(entries: readonly object[]): string {
    return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
  }

  /**
   * A query that answers each prompt with `text` as message `messageId`, keeping the ids of the
   * prompts it was sent: Claude Code records a prompt under the id it arrives with.
   */
  function replyFactory(text: string, messageId: string, sent: string[]): ClaudeQueryFactory {
    return ({ prompt }) => {
      const messages = (async function* () {
        if (typeof prompt === "string") throw new Error("Expected streaming input");
        for await (const message of prompt) {
          if (typeof message.uuid === "string") sent.push(message.uuid);
          yield { type: "assistant", uuid: messageId, message: { content: text } };
          yield { type: "result", subtype: "success", total_cost_usd: 0 };
        }
      })();
      return Object.assign(messages, {
        close: () => {
          void messages.return();
        },
        interrupt: async () => undefined,
        setModel: async () => undefined,
        setPermissionMode: async () => undefined,
        supportedModels: async () => [],
        supportedCommands: async () => [],
      }) as ReturnType<ClaudeQueryFactory>;
    };
  }

  async function resume(queryFactory?: ClaudeQueryFactory): Promise<AgentSession> {
    const client = new ClaudeAgentClient({
      logger: pino({ level: "silent" }),
      queryFactory:
        queryFactory ??
        (() => {
          throw new Error("syncing history must not start a query");
        }),
      resolveBinary: async () => process.execPath,
      resolveVersion: async () => "2.1.220",
    });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: SESSION_ID },
      { cwd },
    );
    sessions.push(session);
    return session;
  }

  async function history(session: AgentSession): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) events.push(event);
    return events;
  }

  /** What a fresh load of the whole transcript shows. */
  async function fullReload(): Promise<AgentStreamEvent[]> {
    return history(await resume());
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-history-sync-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    mkdirSync(path.dirname(transcriptPath()), { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("reads only the turns appended elsewhere, as a full reload would show them", async () => {
    writeFileSync(
      transcriptPath(),
      lines([
        { type: "user", uuid: "u1", parentUuid: null, message: { content: "first" } },
        { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "first reply" } },
      ]),
    );
    const session = await resume();
    const loaded = await history(session);
    expect(loaded).toHaveLength(2);

    appendFileSync(
      transcriptPath(),
      lines([
        { type: "user", uuid: "u2", parentUuid: "a1", message: { content: "second" } },
        { type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: "second reply" } },
      ]),
    );

    const synced = await session.syncAppendedHistory!();
    expect(synced).toEqual({
      kind: "appended",
      events: [
        {
          type: "timeline",
          provider: "claude",
          timestamp: undefined,
          item: { type: "user_message", messageId: "u2", text: "second" },
        },
        {
          type: "timeline",
          provider: "claude",
          timestamp: undefined,
          item: { type: "assistant_message", messageId: "a2", text: "second reply" },
        },
      ],
    });
    expect(synced).toEqual({ kind: "appended", events: (await fullReload()).slice(loaded.length) });
    expect(await session.syncAppendedHistory!()).toEqual({ kind: "unchanged" });
  });

  test("does not read back the turn this session ran itself", async () => {
    writeFileSync(
      transcriptPath(),
      lines([
        { type: "user", uuid: "u1", parentUuid: null, message: { content: "first" } },
        { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "first reply" } },
      ]),
    );
    const sent: string[] = [];
    const session = await resume(replyFactory("live reply", "live-a", sent));
    await history(session);
    await collectSessionTurnEvents(session, "live prompt");
    expect(sent).toHaveLength(1);
    const promptId = sent[0];
    // Claude Code writes the turn it ran to the same transcript.
    appendFileSync(
      transcriptPath(),
      lines([
        { type: "user", uuid: promptId, parentUuid: "a1", message: { content: "live prompt" } },
        {
          type: "assistant",
          uuid: "live-a",
          parentUuid: promptId,
          message: { content: "live reply" },
        },
      ]),
    );
    expect(await session.syncAppendedHistory!()).toEqual({ kind: "unchanged" });
  });

  test("does not read back a steered prompt, journaled under an id of its own", async () => {
    writeFileSync(
      transcriptPath(),
      lines([
        { type: "user", uuid: "u1", parentUuid: null, message: { content: "first" } },
        { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "first reply" } },
      ]),
    );
    const sent: string[] = [];
    const session = await resume(replyFactory("live reply", "live-a", sent));
    await history(session);
    await collectSessionTurnEvents(session, "steered prompt");
    const promptId = sent[0];
    // Claude Code journals a prompt it took in mid-turn as a queued command, under a
    // record id of its own; the prompt's id is its source.
    appendFileSync(
      transcriptPath(),
      lines([
        {
          type: "attachment",
          uuid: "queued-record",
          parentUuid: "a1",
          attachment: {
            type: "queued_command",
            commandMode: "prompt",
            prompt: "steered prompt",
            source_uuid: promptId,
          },
        },
      ]),
    );
    expect(await session.syncAppendedHistory!()).toEqual({ kind: "unchanged" });
  });

  test("reads what two syncs at once find only once", async () => {
    writeFileSync(
      transcriptPath(),
      lines([{ type: "user", uuid: "u1", parentUuid: null, message: { content: "first" } }]),
    );
    const session = await resume();
    await history(session);
    appendFileSync(
      transcriptPath(),
      lines([{ type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "reply" } }]),
    );
    const [first, second] = await Promise.all([
      session.syncAppendedHistory!(),
      session.syncAppendedHistory!(),
    ]);
    expect(first).toEqual({
      kind: "appended",
      events: [
        {
          type: "timeline",
          provider: "claude",
          timestamp: undefined,
          item: { type: "assistant_message", messageId: "a1", text: "reply" },
        },
      ],
    });
    expect(second).toEqual({ kind: "unchanged" });
  });

  test("leaves a line still being written for the next sync", async () => {
    writeFileSync(
      transcriptPath(),
      lines([{ type: "user", uuid: "u1", parentUuid: null, message: { content: "first" } }]),
    );
    const session = await resume();
    await history(session);
    const reply = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      message: { content: "first reply" },
    });
    appendFileSync(transcriptPath(), reply.slice(0, 20));
    expect(await session.syncAppendedHistory!()).toEqual({ kind: "unchanged" });
    appendFileSync(transcriptPath(), `${reply.slice(20)}\n`);
    expect(await session.syncAppendedHistory!()).toEqual({
      kind: "appended",
      events: [
        {
          type: "timeline",
          provider: "claude",
          timestamp: undefined,
          item: { type: "assistant_message", messageId: "a1", text: "first reply" },
        },
      ],
    });
  });

  test("asks for a reload when the appended part cannot be read on its own", async () => {
    const start = lines([
      { type: "user", uuid: "u1", parentUuid: null, message: { content: "first" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: "first reply" } },
    ]);
    const cases: { appended: object; reason: string }[] = [
      {
        appended: {
          type: "user",
          uuid: "u9",
          parentUuid: "elsewhere",
          message: { content: "fork" },
        },
        reason: "a record on another branch",
      },
      {
        appended: {
          type: "assistant",
          uuid: "a9",
          parentUuid: "a1",
          message: { content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }] },
        },
        reason: "a subagent call",
      },
      {
        appended: {
          type: "assistant",
          uuid: "a8",
          parentUuid: "a1",
          message: { content: [{ type: "tool_use", id: "t2", name: "Workflow", input: {} }] },
        },
        reason: "a subagent call",
      },
      {
        appended: {
          type: "user",
          uuid: "s9",
          parentUuid: "a1",
          isSidechain: true,
          message: { content: "x" },
        },
        reason: "a subagent record",
      },
      {
        appended: { type: "system", subtype: "compact_boundary", uuid: "c9", parentUuid: "a1" },
        reason: "a compaction",
      },
    ];
    for (const { appended, reason } of cases) {
      writeFileSync(transcriptPath(), start);
      const session = await resume();
      await history(session);
      appendFileSync(transcriptPath(), lines([appended]));
      expect(await session.syncAppendedHistory!()).toEqual({ kind: "reload", reason });
    }

    // Rewound to the first prompt, the conversation goes on in a new transcript: the old
    // one is not read into it.
    {
      writeFileSync(transcriptPath(), start);
      const session = await resume();
      await history(session);
      await session.revertConversation!({ messageId: "u1" });
      appendFileSync(
        transcriptPath(),
        lines([{ type: "user", uuid: "u2", parentUuid: "a1", message: { content: "old" } }]),
      );
      expect(await session.syncAppendedHistory!()).toEqual({
        kind: "reload",
        reason: "no transcript was loaded",
      });
    }

    writeFileSync(transcriptPath(), start);
    const session = await resume();
    await history(session);
    rmSync(transcriptPath());
    writeFileSync(transcriptPath(), start);
    expect(await session.syncAppendedHistory!()).toEqual({
      kind: "reload",
      reason: "the transcript was rewritten",
    });
  });
});
