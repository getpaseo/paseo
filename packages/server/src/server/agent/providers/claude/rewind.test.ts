import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

import {
  revertClaudeConversation,
  revertClaudeConversationAndFiles,
  revertClaudeFiles,
  realClaudeRewindSdk,
} from "./rewind.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";

describe("Claude rewind", () => {
  test("forks the conversation up to the user message", async () => {
    const claude = new FakeClaudeSdk();
    let sessionId = "original-session";

    await revertClaudeConversation({
      sdk: claude,
      sessionId,
      transcriptPath: "/claude/projects/repo/original-session.jsonl",
      messageId: "user-message-1",
      setSessionId: (nextSessionId) => {
        sessionId = nextSessionId;
      },
    });

    expect(claude.recordedForks).toEqual([{ upToMessageId: "user-message-1" }]);
    expect(sessionId).toBe("forked-session-1");
  });

  test("translates Paseo timeline message ids before forking", async () => {
    const claude = new FakeClaudeSdk();
    let sessionId = "original-session";

    await revertClaudeConversation({
      sdk: claude,
      sessionId,
      transcriptPath: "/claude/projects/repo/original-session.jsonl",
      messageId: "timeline-message-1",
      resolveMessageId: () => "claude-jsonl-message-1",
      setSessionId: (nextSessionId) => {
        sessionId = nextSessionId;
      },
    });

    expect(claude.recordedForks).toEqual([{ upToMessageId: "claude-jsonl-message-1" }]);
    expect(sessionId).toBe("forked-session-1");
  });

  test("rewinds tracked files to the user message", async () => {
    const claude = new FakeClaudeSdk();

    await revertClaudeFiles({
      query: claude.createQuery() as Query,
      messageId: "user-message-1",
    });

    expect(claude.recordedFileRewinds).toEqual([{ userMessageId: "user-message-1" }]);
  });

  test("translates Paseo timeline message ids before rewinding files", async () => {
    const claude = new FakeClaudeSdk();

    await revertClaudeFiles({
      query: claude.createQuery() as Query,
      messageId: "timeline-message-1",
      resolveMessageId: () => "claude-jsonl-message-1",
    });

    expect(claude.recordedFileRewinds).toEqual([{ userMessageId: "claude-jsonl-message-1" }]);
  });

  test("rebinds the Claude session before composed rewind returns for rehydrate", async () => {
    const claude = new FakeClaudeSdk();
    claude.setNextSessionId("forked-before-rehydrate");
    let sessionId = "original-session";

    await revertClaudeConversationAndFiles({
      sdk: claude,
      query: claude.createQuery() as Query,
      sessionId,
      transcriptPath: "/claude/projects/repo/original-session.jsonl",
      messageId: "user-message-1",
      setSessionId: (nextSessionId) => {
        sessionId = nextSessionId;
      },
    });

    expect(claude.recordedFileRewinds).toEqual([{ userMessageId: "user-message-1" }]);
    expect(claude.recordedForks).toEqual([{ upToMessageId: "user-message-1" }]);
    expect(sessionId).toBe("forked-before-rehydrate");
  });
});

interface TranscriptLine {
  type: "user" | "assistant";
  uuid: string;
  parentUuid: string | null;
  text: string;
}

function writeTranscript(
  transcriptPath: string,
  sessionId: string,
  lines: Array<TranscriptLine | string>,
): void {
  const entries = lines.map((line) => {
    if (typeof line === "string") return line;
    const { type, uuid, parentUuid, text } = line;
    return JSON.stringify({
      type,
      uuid,
      parentUuid,
      sessionId,
      cwd: "/repo",
      timestamp: new Date().toISOString(),
      message: { role: type, content: text },
    });
  });
  writeFileSync(transcriptPath, `${entries.join("\n")}\n`, "utf8");
}

function readMessageTexts(transcriptPath: string): string[] {
  const entries = readFileSync(transcriptPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { message?: { content: string } });
  return entries.flatMap((entry) => (entry.message ? [entry.message.content] : []));
}

describe("Claude rewind against the Claude SDK", () => {
  let tempRoot: string | null = null;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  test("forks a session that lives in a provider's own CLAUDE_CONFIG_DIR", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-config-dir-"));
    // The provider sets CLAUDE_CONFIG_DIR for Claude Code; the daemon's own environment does not.
    delete process.env.CLAUDE_CONFIG_DIR;
    const projectDir = path.join(tempRoot, "custom-claude-dir", "projects", "-repo");
    mkdirSync(projectDir, { recursive: true });
    const sessionId = randomUUID();
    const firstUser = randomUUID();
    const firstReply = randomUUID();
    const secondUser = randomUUID();
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    writeTranscript(transcriptPath, sessionId, [
      { type: "user", uuid: firstUser, parentUuid: null, text: "first" },
      { type: "assistant", uuid: firstReply, parentUuid: firstUser, text: "first reply" },
      { type: "user", uuid: secondUser, parentUuid: firstReply, text: "second" },
      { type: "assistant", uuid: randomUUID(), parentUuid: secondUser, text: "second reply" },
    ]);
    let currentSessionId = sessionId;

    await revertClaudeConversation({
      sdk: realClaudeRewindSdk,
      sessionId,
      transcriptPath,
      messageId: firstReply,
      setSessionId: (nextSessionId) => {
        currentSessionId = nextSessionId;
      },
    });

    expect(currentSessionId).not.toBe(sessionId);
    expect(readMessageTexts(path.join(projectDir, `${currentSessionId}.jsonl`))).toEqual([
      "first",
      "first reply",
    ]);
  });

  test("skips transcript lines that are not entries when forking", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-config-dir-"));
    delete process.env.CLAUDE_CONFIG_DIR;
    const projectDir = path.join(tempRoot, "custom-claude-dir", "projects", "-repo");
    mkdirSync(projectDir, { recursive: true });
    const sessionId = randomUUID();
    const firstUser = randomUUID();
    const firstReply = randomUUID();
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    writeTranscript(transcriptPath, sessionId, [
      "null",
      { type: "user", uuid: firstUser, parentUuid: null, text: "first" },
      "[1, 2]",
      '"text"',
      "{}",
      { type: "assistant", uuid: firstReply, parentUuid: firstUser, text: "first reply" },
      { type: "user", uuid: randomUUID(), parentUuid: firstReply, text: "second" },
    ]);
    let currentSessionId = sessionId;

    await revertClaudeConversation({
      sdk: realClaudeRewindSdk,
      sessionId,
      transcriptPath,
      messageId: firstReply,
      setSessionId: (nextSessionId) => {
        currentSessionId = nextSessionId;
      },
    });

    expect(readMessageTexts(path.join(projectDir, `${currentSessionId}.jsonl`))).toEqual([
      "first",
      "first reply",
    ]);
  });
});
