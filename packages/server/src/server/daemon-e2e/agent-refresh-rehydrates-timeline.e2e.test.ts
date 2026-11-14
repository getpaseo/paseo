import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type {
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import {
  MockLoadTestAgentClient,
  MockLoadTestAgentSession,
} from "../agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function sanitizeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/._:]/g, "-");
}

interface ClaudeJsonlEntry {
  type: "user" | "assistant";
  uuid?: string;
  sessionId: string;
  cwd: string;
  message: { role: "user" | "assistant"; content: string };
}

function userEntry(
  sessionId: string,
  cwd: string,
  content: string,
  uuid: string,
): ClaudeJsonlEntry {
  return {
    type: "user",
    uuid,
    sessionId,
    cwd,
    message: { role: "user", content },
  };
}

function assistantEntry(sessionId: string, cwd: string, content: string): ClaudeJsonlEntry {
  return {
    type: "assistant",
    sessionId,
    cwd,
    message: { role: "assistant", content },
  };
}

function timelineText(entries: ReadonlyArray<{ item: { type: string; text?: string } }>): string {
  return entries
    .filter(
      (entry): entry is { item: { type: "user_message" | "assistant_message"; text: string } } =>
        entry.item.type === "user_message" || entry.item.type === "assistant_message",
    )
    .map((entry) => entry.item.text)
    .join("\n");
}

describe("daemon E2E - Reload agent brings in what the on-disk session added", () => {
  let claudeConfigDir: string;
  let prevClaudeConfigDir: string | undefined;
  let cwd: string;
  let sessionFile: string;
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;

  const sessionId = "external-edits-session";

  beforeEach(() => {
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    claudeConfigDir = mkdtempSync(path.join(tmpdir(), "claude-cfg-refresh-"));
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    cwd = mkdtempSync(path.join(tmpdir(), "claude-cwd-refresh-"));
    const projectsDir = path.join(claudeConfigDir, "projects", sanitizeClaudeProjectPath(cwd));
    mkdirSync(projectsDir, { recursive: true });
    sessionFile = path.join(projectsDir, `${sessionId}.jsonl`);

    const initial: ClaudeJsonlEntry[] = [
      userEntry(sessionId, cwd, "first hello", "user-uuid-1"),
      assistantEntry(sessionId, cwd, "first reply"),
    ];
    writeFileSync(
      sessionFile,
      `${initial.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    client = undefined;
    daemon = undefined;
    rmSync(claudeConfigDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (prevClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    }
  }, 60_000);

  test("Reload agent appends entries added externally and keeps the history", async () => {
    const logger = pino({ level: "silent" });
    daemon = await createTestPaseoDaemon({
      agentClients: {
        claude: new ClaudeAgentClient({
          logger,
          resolveBinary: async () => "/test/claude/bin",
        }),
      },
      logger,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({
      subscribe: {},
    });

    const imported = await client.importAgent({ provider: "claude", sessionId, cwd });
    expect(imported.id).toBeTruthy();

    const before = await client.fetchAgentTimeline(imported.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const beforeText = timelineText(before.entries);
    expect(beforeText).toContain("first hello");
    expect(beforeText).toContain("first reply");
    const epochBefore = before.epoch;
    const countBefore = before.entries.length;

    const additions: ClaudeJsonlEntry[] = [
      userEntry(sessionId, cwd, "second hello", "user-uuid-2"),
      assistantEntry(sessionId, cwd, "second reply"),
    ];
    appendFileSync(
      sessionFile,
      `${additions.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    await client.refreshAgent(imported.id);

    const after = await client.fetchAgentTimeline(imported.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const afterText = timelineText(after.entries);
    expect(afterText).toContain("second hello");
    expect(afterText).toContain("second reply");
    expect(after.entries.length).toBeGreaterThan(countBefore);
    // The kept rows are the same rows, so cursors clients hold stay valid.
    expect(after.epoch).toBe(epochBefore);
    expect(after.entries.slice(0, countBefore)).toEqual(before.entries);

    // Reloading again finds nothing new.
    await client.refreshAgent(imported.id);
    const again = await client.fetchAgentTimeline(imported.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(again.epoch).toBe(epochBefore);
    expect(again.entries).toEqual(after.entries);
  }, 30_000);

  test("Reload agent reports an external edit to an earlier answer and keeps the history", async () => {
    const logger = pino({ level: "silent" });
    daemon = await createTestPaseoDaemon({
      agentClients: {
        claude: new ClaudeAgentClient({
          logger,
          resolveBinary: async () => "/test/claude/bin",
        }),
      },
      logger,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const imported = await client.importAgent({ provider: "claude", sessionId, cwd });
    const before = await client.fetchAgentTimeline(imported.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });

    // The session file now holds a different first answer, with only its spacing changed.
    const edited: ClaudeJsonlEntry[] = [
      userEntry(sessionId, cwd, "first hello", "user-uuid-1"),
      assistantEntry(sessionId, cwd, "first  reply"),
      userEntry(sessionId, cwd, "second hello", "user-uuid-2"),
      assistantEntry(sessionId, cwd, "second reply"),
    ];
    writeFileSync(sessionFile, `${edited.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const refreshed = await client.refreshAgent(imported.id);

    expect(refreshed.historyDiverged).toBe(true);
    const after = await client.fetchAgentTimeline(imported.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(after.epoch).toBe(before.epoch);
    expect(after.entries).toEqual(before.entries);
  }, 30_000);
});

// A provider whose sessions report child agents, and that counts every session it resumes.
class ChildReportingSession extends MockLoadTestAgentSession {
  private readonly observers = new Set<(event: AgentStreamEvent) => void>();
  override subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    const unsubscribe = super.subscribe(callback);
    this.observers.add(callback);
    return () => {
      unsubscribe();
      this.observers.delete(callback);
    };
  }
  push(event: AgentStreamEvent): void {
    for (const callback of this.observers) callback(event);
  }
}

class ChildReportingProvider extends MockLoadTestAgentClient {
  session!: ChildReportingSession;
  resumes = 0;
  override async createSession(config: AgentSessionConfig): Promise<ChildReportingSession> {
    this.session = new ChildReportingSession({ config, sessionId: "child-reporting-session" });
    return this.session;
  }
  override async resumeSession(
    handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.resumes += 1;
    return super.resumeSession(handle, config);
  }
}

describe("daemon E2E - an archived agent's history reads without its provider", () => {
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "archived-history-"));
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    client = undefined;
    daemon = undefined;
    rmSync(cwd, { recursive: true, force: true });
  }, 60_000);

  test("the provider children of an archived agent open without resuming the provider", async () => {
    const provider = new ChildReportingProvider();
    daemon = await createTestPaseoDaemon({ isDev: true, agentClients: { mock: provider } });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({ provider: "mock", cwd, model: "ten-second-stream" });
    provider.session.push({
      type: "provider_subagent",
      provider: "mock",
      event: { type: "upsert", id: "child", title: "Child", status: "completed" },
    });
    provider.session.push({
      type: "provider_subagent",
      provider: "mock",
      event: {
        type: "timeline",
        id: "child",
        item: { type: "assistant_message", text: "Child result" },
      },
    });
    const live = await client.fetchProviderSubagentTimeline(agent.id, "child");
    expect(live.rows.map((row) => row.item)).toEqual([
      { type: "assistant_message", text: "Child result" },
    ]);

    await client.archiveAgent(agent.id);

    const children = await client.listProviderSubagents(agent.id);
    expect(children.subagents).toEqual([
      expect.objectContaining({ id: "child", title: "Child", status: "completed" }),
    ]);
    const stored = await client.fetchProviderSubagentTimeline(agent.id, "child");
    expect(stored.rows.map((row) => row.item)).toEqual([
      { type: "assistant_message", text: "Child result" },
    ]);
    expect(stored.epoch).toBe(live.epoch);
    expect(provider.resumes).toBe(0);
  }, 30_000);
});
