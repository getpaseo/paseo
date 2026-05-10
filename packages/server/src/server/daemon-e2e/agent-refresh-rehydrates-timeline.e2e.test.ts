import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
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

describe("daemon E2E - refresh rehydrates timeline from on-disk session", () => {
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

  test("refresh picks up entries appended externally and advances the epoch", async () => {
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
      subscribe: { subscriptionId: "refresh-rehydrate-test" },
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
    expect(after.epoch).not.toBe(epochBefore);
  }, 30_000);
});
