import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentPersistenceHandle, AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

// A custom Claude provider carries its own CLAUDE_CONFIG_DIR (docs/custom-providers.md).
// That value only ever reaches the provider's runtime settings, never the daemon's own
// environment, so history hydration has to read it from there. See issue #2005.

const PROFILE_USER_MARKER = "PROFILE_HISTORY_USER_MARKER";
const PROFILE_ASSISTANT_MARKER = "PROFILE_HISTORY_ASSISTANT_MARKER";
const SESSION_ID = "profile-session";

const queryFactory = vi.fn();

function buildSdkQueryMock() {
  return {
    next: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function writeTranscript(configDir: string, cwd: string): void {
  const historyDir = claudeProjectDirSync(cwd, { configDir });
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(
    path.join(historyDir, `${SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: "user",
        uuid: "profile-user-uuid",
        sessionId: SESSION_ID,
        cwd,
        message: { role: "user", content: PROFILE_USER_MARKER },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: SESSION_ID,
        cwd,
        message: { role: "assistant", content: PROFILE_ASSISTANT_MARKER },
      }),
    ].join("\n"),
    "utf8",
  );
}

function collectTimelineText(events: AgentStreamEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type !== "timeline") {
      continue;
    }
    if (event.item.type === "user_message" || event.item.type === "assistant_message") {
      chunks.push(event.item.text);
    }
  }
  return chunks.join("\n");
}

async function readHistory(client: ClaudeAgentClient, cwd: string): Promise<string> {
  const handle: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: SESSION_ID,
    nativeHandle: SESSION_ID,
    metadata: { provider: "claude", cwd },
  };
  const session = await client.resumeSession(handle, { cwd });
  const events: AgentStreamEvent[] = [];
  try {
    for await (const event of session.streamHistory()) {
      events.push(event);
    }
  } finally {
    await session.close();
  }
  return collectTimelineText(events);
}

describe("Claude history hydration with a provider-scoped CLAUDE_CONFIG_DIR", () => {
  let tempRoot: string;
  let cwd: string;
  let profileConfigDir: string;
  let previousClaudeConfigDir: string | undefined;

  beforeEach(() => {
    queryFactory.mockImplementation(() => buildSdkQueryMock());

    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-profile-config-dir-"));
    cwd = path.join(tempRoot, "repo");
    profileConfigDir = path.join(tempRoot, "profile-claude-config");
    mkdirSync(cwd, { recursive: true });
    writeTranscript(profileConfigDir, cwd);

    // The daemon-wide value must stay unset: it is the blind spot this covers.
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    queryFactory.mockReset();
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("reads the transcript from the provider's config dir", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: profileConfigDir } },
    });

    const timelineText = await readHistory(client, cwd);

    expect(timelineText).toContain(PROFILE_USER_MARKER);
    expect(timelineText).toContain(PROFILE_ASSISTANT_MARKER);
  });

  test("prefers the provider's config dir over the daemon environment", async () => {
    // Two profiles cannot share one daemon-wide value, so the provider's own
    // setting has to win over whatever the daemon happens to carry.
    const decoyConfigDir = path.join(tempRoot, "daemon-claude-config");
    mkdirSync(decoyConfigDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = decoyConfigDir;

    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: profileConfigDir } },
    });

    const timelineText = await readHistory(client, cwd);

    expect(timelineText).toContain(PROFILE_USER_MARKER);
  });

  test("lists importable sessions from the provider's config dir", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: profileConfigDir } },
    });

    const sessions = await client.listImportableSessions({ cwd });

    expect(sessions.map((session) => session.providerHandleId)).toContain(SESSION_ID);
  });
});
