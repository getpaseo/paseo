import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const SESSION_ID = "history-sync-e2e-session";
const PROVIDER_ID = "claude-sync";

function lines(entries: readonly object[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

describe("daemon E2E - syncing what another Claude Code process appended", () => {
  let tempRoot: string;
  let configDir: string;
  let cwd: string;
  let transcript: string;
  let prevClaudeConfigDir: string | undefined;
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-history-sync-e2e-"));
    configDir = path.join(tempRoot, "claude-config");
    cwd = path.join(tempRoot, "repo");
    mkdirSync(cwd, { recursive: true });
    const projectDir = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(projectDir, { recursive: true });
    transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(
      transcript,
      lines([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: SESSION_ID,
          cwd,
          message: { role: "user", content: "first" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: SESSION_ID,
          cwd,
          message: { role: "assistant", content: "first reply" },
        },
      ]),
    );
    // Only the provider's env names the directory, as in claude-provider-config-dir-history.
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  async function connect(): Promise<DaemonClient> {
    daemon = await createTestPaseoDaemon({
      providerOverrides: {
        [PROVIDER_ID]: {
          extends: "claude",
          label: "Claude (sync)",
          env: { CLAUDE_CONFIG_DIR: configDir },
        },
      },
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return client;
  }

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    client = undefined;
    daemon = undefined;
    rmSync(tempRoot, { recursive: true, force: true });
    if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
  }, 60_000);

  test("appends only the new turn to the timeline, in the same epoch", async () => {
    client = await connect();
    expect(client.getLastServerInfoMessage()?.features?.agentHistorySync).toBe(true);

    const agent = await client.importAgent({ provider: PROVIDER_ID, sessionId: SESSION_ID, cwd });
    const before = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });

    appendFileSync(
      transcript,
      lines([
        {
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          sessionId: SESSION_ID,
          cwd,
          message: { role: "user", content: "second" },
        },
        {
          type: "assistant",
          uuid: "a2",
          parentUuid: "u2",
          sessionId: SESSION_ID,
          cwd,
          message: { role: "assistant", content: "second reply" },
        },
      ]),
    );

    expect(await client.syncAgentHistory(agent.id)).toEqual({
      outcome: "appended",
      appendedItems: 2,
      timelineSize: before.entries.length + 2,
    });
    const after = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(after.epoch).toBe(before.epoch);
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
    expect(after.entries.slice(before.entries.length).map((entry) => entry.item)).toEqual([
      { type: "user_message", messageId: "u2", text: "second" },
      { type: "assistant_message", messageId: "a2", text: "second reply" },
    ]);

    expect(await client.syncAgentHistory(agent.id)).toEqual({
      outcome: "unchanged",
      appendedItems: 0,
      timelineSize: before.entries.length + 2,
    });
  }, 60_000);

  test("reloads the agent when the appended part continues another branch", async () => {
    client = await connect();
    const agent = await client.importAgent({ provider: PROVIDER_ID, sessionId: SESSION_ID, cwd });

    appendFileSync(
      transcript,
      lines([
        {
          type: "user",
          uuid: "u9",
          parentUuid: "not-held",
          sessionId: SESSION_ID,
          cwd,
          message: { role: "user", content: "elsewhere" },
        },
      ]),
    );

    const result = await client.syncAgentHistory(agent.id);
    expect(result.outcome).toBe("reloaded");
    const after = await client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(after.entries.map((entry) => entry.item)).toContainEqual({
      type: "user_message",
      messageId: "u9",
      text: "elsewhere",
    });
    expect(result.timelineSize).toBe(after.entries.length);
  }, 60_000);
});
