import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Claude Code resumes a session by id from any working directory and keeps writing to the
// transcript under the project folder it started in. The agent's cwd can name a different
// folder: a project that moved, a daemon migrated between machines or containers, or Claude
// Code running under WSL interop and seeing the cwd as a Windows path.
// The test daemon fakes the built-in providers; a provider that extends `claude` runs the real one.
const PROVIDER_ID = "claude-real";
const SESSION_ID = "6f0c5d8e-4c3a-4f7b-9a51-2d8e1b7c9f10";

function timelineText(entries: ReadonlyArray<{ item: { type: string; text?: string } }>): string {
  return entries
    .filter(
      (
        entry,
      ): entry is {
        item: { type: "user_message" | "assistant_message"; text: string };
      } => entry.item.type === "user_message" || entry.item.type === "assistant_message",
    )
    .map((entry) => entry.item.text)
    .join("\n");
}

describe("daemon E2E - Claude history stored under another project folder", () => {
  let tempRoot: string;
  let paseoHomeRoot: string;
  let configDir: string;
  let transcriptCwd: string;
  let agentCwd: string;
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-history-other-project-"));
    paseoHomeRoot = path.join(tempRoot, "paseo-home");
    configDir = path.join(tempRoot, "claude-config");
    transcriptCwd = path.join(tempRoot, "where-claude-started");
    agentCwd = path.join(tempRoot, "agent-cwd");
    mkdirSync(paseoHomeRoot, { recursive: true });
    mkdirSync(agentCwd, { recursive: true });

    const projectDir = claudeProjectDirSync(transcriptCwd, { configDir });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${SESSION_ID}.jsonl`),
      [
        {
          type: "user",
          uuid: "user-uuid-1",
          sessionId: SESSION_ID,
          cwd: transcriptCwd,
          message: { role: "user", content: "hello from the original folder" },
        },
        {
          type: "assistant",
          sessionId: SESSION_ID,
          cwd: transcriptCwd,
          message: {
            role: "assistant",
            content: "reply from the original folder",
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join(""),
      "utf8",
    );
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    client = undefined;
    daemon = undefined;
    rmSync(tempRoot, { recursive: true, force: true });
  }, 60_000);

  async function startDaemon(): Promise<DaemonClient> {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      cleanup: false,
      providerOverrides: {
        [PROVIDER_ID]: {
          extends: "claude",
          label: "Claude",
          env: { CLAUDE_CONFIG_DIR: configDir },
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
      cwd: agentCwd,
    });
    await stopDaemon();

    const restartedClient = await startDaemon();
    const timeline = await restartedClient.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });

    const text = timelineText(timeline.entries);
    expect(text).toContain("hello from the original folder");
    expect(text).toContain("reply from the original folder");
  }, 60_000);
});
