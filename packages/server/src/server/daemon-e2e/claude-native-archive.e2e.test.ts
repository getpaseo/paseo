import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Archiving a Claude agent archives its Claude Code session (the Agent SDK's archived.json beside
// the transcript), so Import session no longer offers it, as for a Codex agent; refreshing the
// archived agent unarchives it. No Claude Code process runs: import reads the transcript, and the
// archive goes through the SDK; a stand-in `claude` on PATH only makes the provider available.

const SESSION_ID = "2c7b2d66-4a4f-4b54-8b8f-1a4a6e2c3d01";

describe("daemon E2E - archiving a Claude agent archives its Claude Code session", () => {
  let tempRoot: string;
  let configDir: string;
  let cwd: string;
  let mark: string;
  let prevClaudeConfigDir: string | undefined;
  let prevPath: string | undefined;
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-native-archive-"));
    configDir = path.join(tempRoot, "claude");
    cwd = path.join(tempRoot, "repo");
    mkdirSync(cwd, { recursive: true });
    const projectDir = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${SESSION_ID}.jsonl`),
      `${JSON.stringify({
        type: "user",
        uuid: "2c7b2d66-4a4f-4b54-8b8f-1a4a6e2c3daa",
        parentUuid: null,
        sessionId: SESSION_ID,
        cwd,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hello from the archived session" },
      })}\n`,
    );
    mark = path.join(projectDir, SESSION_ID, "archived.json");
    // The daemon's own Claude config dir, which the Agent SDK reads.
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    // The machine's own Claude Code is never found: PATH has the stand-in and the system folders.
    const bin = path.join(tempRoot, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho '2.1.323 (Claude Code)'\n", {
      mode: 0o755,
    });
    prevPath = process.env.PATH;
    process.env.PATH = [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
      path.delimiter,
    );
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    client = undefined;
    daemon = undefined;
    rmSync(tempRoot, { recursive: true, force: true });
    process.env.PATH = prevPath;
    if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
  }, 60_000);

  async function importable(): Promise<string[]> {
    const recent = await client!.fetchRecentProviderSessions({ cwd, providers: ["claude"] });
    return recent.entries.map((entry) => entry.providerHandleId);
  }

  test("an archived Claude agent's session leaves Import session until the agent is refreshed", async () => {
    const logger = pino({ level: "warn" });
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: path.join(tempRoot, "paseo-home"),
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    expect(await importable()).toEqual([SESSION_ID]);

    const agent = await client.importAgent({ provider: "claude", sessionId: SESSION_ID, cwd });
    await client.archiveAgent(agent.id);
    expect(JSON.parse(readFileSync(mark, "utf8")).archived).toBe(true);
    expect(await importable()).toEqual([]);

    await client.refreshAgent(agent.id);
    expect(existsSync(mark)).toBe(true);
    expect(JSON.parse(readFileSync(mark, "utf8")).archived).toBe(false);
  }, 60_000);
});
