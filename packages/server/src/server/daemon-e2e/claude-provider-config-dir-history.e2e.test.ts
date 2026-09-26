import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const PROVIDER_ID = "claude-secondary";
const SESSION_ID = "provider-config-dir-session";

function timelineText(entries: ReadonlyArray<{ item: { type: string; text?: string } }>): string {
  return entries
    .filter(
      (entry): entry is { item: { type: "user_message" | "assistant_message"; text: string } } =>
        entry.item.type === "user_message" || entry.item.type === "assistant_message",
    )
    .map((entry) => entry.item.text)
    .join("\n");
}

describe("daemon E2E - Claude history lives in the provider's CLAUDE_CONFIG_DIR", () => {
  let tempRoot: string;
  let paseoHomeRoot: string;
  let providerConfigDir: string;
  let cwd: string;
  let prevClaudeConfigDir: string | undefined;
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-provider-config-dir-"));
    paseoHomeRoot = path.join(tempRoot, "paseo-home");
    providerConfigDir = path.join(tempRoot, "custom-claude-dir");
    cwd = path.join(tempRoot, "repo");
    mkdirSync(paseoHomeRoot, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const projectDir = claudeProjectDirSync(cwd, { configDir: providerConfigDir });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${SESSION_ID}.jsonl`),
      [
        {
          type: "user",
          uuid: "user-uuid-1",
          sessionId: SESSION_ID,
          cwd,
          message: { role: "user", content: "hello from the custom config dir" },
        },
        {
          type: "assistant",
          sessionId: SESSION_ID,
          cwd,
          message: { role: "assistant", content: "reply from the custom config dir" },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );

    // The daemon's own environment does not name the directory; only the provider's env does.
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    client = undefined;
    daemon = undefined;
    rmSync(tempRoot, { recursive: true, force: true });
    if (prevClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    }
  }, 60_000);

  async function startDaemon(): Promise<DaemonClient> {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      cleanup: false,
      providerOverrides: {
        [PROVIDER_ID]: {
          extends: "claude",
          label: "Claude (secondary)",
          env: { CLAUDE_CONFIG_DIR: providerConfigDir },
        },
      },
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return client;
  }

  async function stopDaemon(): Promise<void> {
    await client?.close();
    await daemon?.close();
    client = undefined;
    daemon = undefined;
  }

  test("an agent's timeline survives a daemon restart", async () => {
    const firstClient = await startDaemon();
    const agent = await firstClient.importAgent({
      provider: PROVIDER_ID,
      sessionId: SESSION_ID,
      cwd,
    });
    await stopDaemon();

    const restartedClient = await startDaemon();
    const timeline = await restartedClient.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });

    const text = timelineText(timeline.entries);
    expect(text).toContain("hello from the custom config dir");
    expect(text).toContain("reply from the custom config dir");
  }, 60_000);

  test("the import list finds the provider's sessions", async () => {
    const daemonClient = await startDaemon();
    const recent = await daemonClient.fetchRecentProviderSessions({
      cwd,
      providers: [PROVIDER_ID],
    });

    expect(recent.entries.map((entry) => entry.providerHandleId)).toContain(SESSION_ID);
  }, 60_000);
});
