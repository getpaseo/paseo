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

// The discriminating shape: a decoy directory sits at process.env.CLAUDE_CONFIG_DIR — the
// daemon's own launch environment — and contains no transcript. The real transcript lives
// under a second directory declared only through this provider's runtimeSettings.env. A test
// that instead read the transcript directory from process.env would pass whether or not the
// provider honours runtimeSettings.env on read-back, and would prove nothing.
describe("daemon E2E - refresh follows the provider's own CLAUDE_CONFIG_DIR, not the daemon's", () => {
  let decoyConfigDir: string;
  let realConfigDir: string;
  let prevClaudeConfigDir: string | undefined;
  let cwd: string;
  let sessionFile: string;
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;

  const sessionId = "provider-env-session";

  beforeEach(() => {
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    decoyConfigDir = mkdtempSync(path.join(tmpdir(), "claude-cfg-decoy-"));
    process.env.CLAUDE_CONFIG_DIR = decoyConfigDir;

    realConfigDir = mkdtempSync(path.join(tmpdir(), "claude-cfg-real-"));

    cwd = mkdtempSync(path.join(tmpdir(), "claude-cwd-provider-env-"));
    const projectsDir = path.join(realConfigDir, "projects", sanitizeClaudeProjectPath(cwd));
    mkdirSync(projectsDir, { recursive: true });
    sessionFile = path.join(projectsDir, `${sessionId}.jsonl`);

    const initial: ClaudeJsonlEntry[] = [
      userEntry(sessionId, cwd, "real dir hello", "user-uuid-1"),
      assistantEntry(sessionId, cwd, "real dir reply"),
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
    rmSync(decoyConfigDir, { recursive: true, force: true });
    rmSync(realConfigDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (prevClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    }
  }, 60_000);

  test("refresh rehydrates from runtimeSettings.env's CLAUDE_CONFIG_DIR, not process.env's", async () => {
    const logger = pino({ level: "silent" });
    daemon = await createTestPaseoDaemon({
      agentClients: {
        claude: new ClaudeAgentClient({
          logger,
          resolveBinary: async () => "/test/claude/bin",
          runtimeSettings: { env: { CLAUDE_CONFIG_DIR: realConfigDir } },
        }),
      },
      logger,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: "refresh-provider-env-test" },
    });

    const imported = await client.importAgent({ provider: "claude", sessionId, cwd });
    expect(imported.id).toBeTruthy();

    const before = await client.fetchAgentTimeline(imported.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const beforeText = timelineText(before.entries);
    // This is the discriminating assertion: it reads from realConfigDir (declared only via
    // runtimeSettings.env), which the daemon's own process.env.CLAUDE_CONFIG_DIR (the decoy)
    // never points at. Before the fix, resolveHistoryPath read process.env directly and found
    // nothing in the decoy directory, so the timeline was empty here.
    expect(beforeText).toContain("real dir hello");
    expect(beforeText).toContain("real dir reply");
    const epochBefore = before.epoch;
    const countBefore = before.entries.length;

    const additions: ClaudeJsonlEntry[] = [
      userEntry(sessionId, cwd, "real dir second hello", "user-uuid-2"),
      assistantEntry(sessionId, cwd, "real dir second reply"),
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
    expect(afterText).toContain("real dir second hello");
    expect(afterText).toContain("real dir second reply");
    expect(after.entries.length).toBeGreaterThan(countBefore);
    expect(after.epoch).not.toBe(epochBefore);
  }, 30_000);
});
