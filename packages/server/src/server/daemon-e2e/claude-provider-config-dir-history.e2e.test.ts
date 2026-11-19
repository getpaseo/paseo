import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const PROVIDER_ID = "claude-secondary";
const SESSION_ID = "40a6ff40-896b-4995-866f-3527fe241ba5";
const FIRST_PROMPT = "fc00ad34-d9c0-4404-aada-b52d8dc0de26";
const FIRST_REPLY = "1a32d4bf-fb8f-4628-a19b-868bb39be26d";

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
          uuid: FIRST_PROMPT,
          parentUuid: null,
          sessionId: SESSION_ID,
          cwd,
          message: { role: "user", content: "hello from the custom config dir" },
        },
        {
          type: "assistant",
          uuid: FIRST_REPLY,
          parentUuid: FIRST_PROMPT,
          sessionId: SESSION_ID,
          cwd,
          message: { role: "assistant", content: "reply from the custom config dir" },
        },
        { type: "custom-title", customTitle: "Renamed provider session", sessionId: SESSION_ID },
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
    expect(agent.title).toBe("Renamed provider session");
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

  test("restarting before a replacement prompt restores the unedited conversation", async () => {
    const secondPrompt = "98d0aea9-15e8-43a0-8130-49a3053dbf32";
    const projectDir = claudeProjectDirSync(cwd, { configDir: providerConfigDir });
    appendFileSync(
      path.join(projectDir, `${SESSION_ID}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: secondPrompt,
        parentUuid: FIRST_REPLY,
        sessionId: SESSION_ID,
        cwd,
        message: { role: "user", content: "second question" },
      }) + "\n",
    );
    const original =
      "hello from the custom config dir\nreply from the custom config dir\nsecond question";
    const firstClient = await startDaemon();
    const agent = await firstClient.importAgent({
      provider: PROVIDER_ID,
      sessionId: SESSION_ID,
      cwd,
    });
    const texts = async (connection: DaemonClient) =>
      timelineText(
        (
          await connection.fetchAgentTimeline(agent.id, {
            direction: "tail",
            limit: 0,
            projection: "canonical",
          })
        ).entries,
      );
    expect(await texts(firstClient)).toBe(original);
    await firstClient.rewindAgent(agent.id, secondPrompt, "conversation");
    expect(await texts(firstClient)).toBe(
      "hello from the custom config dir\nreply from the custom config dir",
    );
    await stopDaemon();

    const restarted = await startDaemon();
    expect(await texts(restarted)).toBe(original);
    expect((await restarted.fetchAgent({ agentId: agent.id }))?.agent.persistence?.sessionId).toBe(
      SESSION_ID,
    );
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
