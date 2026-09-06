import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";

const SESSION_CWD = "/tmp/paseo-claude-renamed-import";

interface ClaudeTranscriptRecord {
  [key: string]: unknown;
}

let configDir: string;
let previousConfigDir: string | undefined;

function userRecord(sessionId: string, content: string): ClaudeTranscriptRecord {
  return {
    isSidechain: false,
    type: "user",
    message: { role: "user", content },
    cwd: SESSION_CWD,
    sessionId,
  };
}

async function writeSession(sessionId: string, records: ClaudeTranscriptRecord[]): Promise<void> {
  const projectDir = claudeProjectDirSync(SESSION_CWD, { configDir });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

// Resuming would spawn Claude Code. The import path only reads history from the
// session it gets back, so an empty history is enough to observe the config.
async function importSession(sessionId: string) {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
  });
  client.resumeSession = async () =>
    ({
      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {},
    }) as unknown as AgentSession;

  return client.importSession(
    { providerHandleId: sessionId, cwd: SESSION_CWD },
    {
      config: { provider: "claude", cwd: SESSION_CWD },
      storedConfig: { provider: "claude", cwd: SESSION_CWD },
    },
  );
}

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-renamed-"));
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("importing a renamed Claude session", () => {
  test("names the imported agent after a /rename", async () => {
    const sessionId = "renamed-session";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "My research session", sessionId },
    ]);

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBe("My research session");
  });

  test("uses the last rename when the session was renamed more than once", async () => {
    const sessionId = "renamed-twice";
    await writeSession(sessionId, [
      userRecord(sessionId, "Move invoices to the new schema"),
      { type: "custom-title", customTitle: "invoices", sessionId },
      { type: "custom-title", customTitle: "billing rework", sessionId },
    ]);

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBe("billing rework");
  });

  test("keeps the rename when a later record carries no usable name", async () => {
    const sessionId = "malformed-later-record";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "My research session", sessionId },
      { type: "custom-title", sessionId },
    ]);

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBe("My research session");
  });

  test("ignores a rename recorded on a sidechain transcript", async () => {
    const sessionId = "sidechain-rename";
    await writeSession(sessionId, [
      userRecord(sessionId, "Review this project"),
      { type: "custom-title", customTitle: "Subagent title", sessionId, isSidechain: true },
    ]);

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBeUndefined();
  });

  test("leaves the agent untitled when the session was never renamed", async () => {
    const sessionId = "never-renamed";
    await writeSession(sessionId, [userRecord(sessionId, "Review this project")]);

    const imported = await importSession(sessionId);

    expect(imported.config.title).toBeUndefined();
  });

  test("does not name the imported agent after a generated ai-title", async () => {
    const sessionId = "auto-titled";
    await writeSession(sessionId, [
      userRecord(sessionId, "Add pagination to the invoice list"),
      { type: "ai-title", aiTitle: "Invoice list pagination", sessionId },
    ]);

    const imported = await importSession(sessionId);

    // The Import Session list shows it, but agents are named from their first
    // prompt line.
    expect(imported.config.title).toBeUndefined();
  });

  test("imports a session that has no transcript on disk", async () => {
    const imported = await importSession("no-such-session");

    expect(imported.config.title).toBeUndefined();
  });

  test("surfaces an unreadable transcript instead of importing it as never renamed", async () => {
    const sessionId = "unreadable-transcript";
    // A directory where the transcript belongs fails the read with EISDIR, the
    // deterministic stand-in for a permissions or I/O fault.
    const projectDir = claudeProjectDirSync(SESSION_CWD, { configDir });
    await fs.mkdir(path.join(projectDir, `${sessionId}.jsonl`), { recursive: true });

    await expect(importSession(sessionId)).rejects.toThrow();
  });
});
