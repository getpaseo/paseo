import { randomUUID } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test } from "vitest";
import { forkSession, type Query } from "@anthropic-ai/claude-agent-sdk";

import { measureMainThreadWork } from "../../../../test-utils/main-thread-work.js";
import {
  findSteeredMessageParent,
  revertClaudeConversation,
  revertClaudeConversationAndFiles,
  revertClaudeFiles,
  realClaudeRewindSdk,
} from "./rewind.js";
import { projectFolderSessionStore } from "./rewind-session-store.js";
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

  test("forks just before a message steered into a running turn", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-steer-"));
    delete process.env.CLAUDE_CONFIG_DIR;
    const projectDir = path.join(tempRoot, "projects", "-repo");
    mkdirSync(projectDir, { recursive: true });
    const sessionId = randomUUID();
    const firstUser = randomUUID();
    const toolUse = randomUUID();
    const toolResult = randomUUID();
    const steeredMessage = randomUUID();
    const queuedCommand = randomUUID();
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    writeTranscript(transcriptPath, sessionId, [
      { type: "user", uuid: firstUser, parentUuid: null, text: "first" },
      { type: "assistant", uuid: toolUse, parentUuid: firstUser, text: "running a tool" },
      { type: "user", uuid: toolResult, parentUuid: toolUse, text: "tool output" },
      // What Claude Code writes when it reads a steered message between two tool calls.
      JSON.stringify({
        type: "attachment",
        uuid: queuedCommand,
        parentUuid: toolResult,
        sessionId,
        attachment: {
          type: "queued_command",
          prompt: [{ type: "text", text: "steered" }],
          source_uuid: steeredMessage,
        },
      }),
      { type: "assistant", uuid: randomUUID(), parentUuid: queuedCommand, text: "reply to steer" },
    ]);

    const parent = await findSteeredMessageParent(transcriptPath, steeredMessage);
    expect(parent).toBe(toolResult);
    expect(await findSteeredMessageParent(transcriptPath, randomUUID())).toBeNull();

    let currentSessionId = sessionId;
    await revertClaudeConversation({
      sdk: realClaudeRewindSdk,
      sessionId,
      transcriptPath,
      messageId: parent!,
      setSessionId: (nextSessionId) => {
        currentSessionId = nextSessionId;
      },
    });
    expect(readMessageTexts(path.join(projectDir, `${currentSessionId}.jsonl`))).toEqual([
      "first",
      "running a tool",
      "tool output",
    ]);
  });

  test("writes the fork beside the original and leaves the original untouched", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-fork-"));
    const projectDir = path.join(tempRoot, "projects", "-repo");
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
    const original = readFileSync(transcriptPath, "utf8");

    const fork = await realClaudeRewindSdk.forkSession(sessionId, {
      upToMessageId: secondUser,
      transcriptPath,
    });

    const forkPath = path.join(projectDir, `${fork.sessionId}.jsonl`);
    expect(readdirSync(projectDir).sort()).toEqual(
      [`${sessionId}.jsonl`, `${fork.sessionId}.jsonl`].sort(),
    );
    expect(readMessageTexts(forkPath)).toEqual(["first", "first reply", "second"]);
    const forkSessionIds = readFileSync(forkPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { sessionId: string }).sessionId);
    expect(forkSessionIds).toEqual([
      fork.sessionId,
      fork.sessionId,
      fork.sessionId,
      fork.sessionId,
    ]);
    expect(readFileSync(transcriptPath, "utf8")).toBe(original);
  });

  test("rejects with the SDK's own error when the transcript is missing", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-missing-"));
    const sessionId = randomUUID();

    await expect(
      realClaudeRewindSdk.forkSession(sessionId, {
        upToMessageId: randomUUID(),
        transcriptPath: path.join(tempRoot, `${sessionId}.jsonl`),
      }),
    ).rejects.toThrow(new Error(`Session ${sessionId} not found`));
  });

  test("rejects with the name and message of the error the SDK raises", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-invalid-"));
    const sessionId = randomUUID();
    const sdkError = await forkSession(sessionId, { upToMessageId: "not-a-uuid" }).then(
      () => null,
      (error: Error) => error,
    );
    expect(sdkError).toBeInstanceOf(Error);

    await expect(
      realClaudeRewindSdk.forkSession(sessionId, {
        upToMessageId: "not-a-uuid",
        transcriptPath: path.join(tempRoot, `${sessionId}.jsonl`),
      }),
    ).rejects.toMatchObject({ name: sdkError?.name, message: sdkError?.message });
  });

  test("keeps a filesystem error's code when the fork fails in the worker", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-eisdir-"));
    const sessionId = randomUUID();
    const transcriptPath = path.join(tempRoot, `${sessionId}.jsonl`);
    mkdirSync(transcriptPath);

    await expect(
      realClaudeRewindSdk.forkSession(sessionId, { upToMessageId: randomUUID(), transcriptPath }),
    ).rejects.toMatchObject({ name: "Error", code: "EISDIR" });
  });

  test("forks one conversation at a time", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-queue-"));
    const projectDir = path.join(tempRoot, "projects", "-repo");
    mkdirSync(projectDir, { recursive: true });
    const forks = [randomUUID(), randomUUID()].map((sessionId) => {
      const user = randomUUID();
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      writeTranscript(transcriptPath, sessionId, [
        { type: "user", uuid: user, parentUuid: null, text: "first" },
        { type: "assistant", uuid: randomUUID(), parentUuid: user, text: "first reply" },
      ]);
      return { sessionId, upToMessageId: user, transcriptPath };
    });
    const events: string[] = [];
    let started = 0;
    function recordWorker(message: unknown): void {
      if (typeof message !== "object" || message === null || !("worker" in message)) return;
      if (!(message.worker instanceof Worker)) return;
      const fork = ++started;
      events.push(`start ${fork}`);
      message.worker.once("message", () => events.push(`reply ${fork}`));
    }

    subscribe("worker_threads", recordWorker);
    try {
      await Promise.all(
        forks.map(({ sessionId, upToMessageId, transcriptPath }) =>
          realClaudeRewindSdk.forkSession(sessionId, { upToMessageId, transcriptPath }),
        ),
      );
    } finally {
      unsubscribe("worker_threads", recordWorker);
    }

    expect(events).toEqual(["start 1", "reply 1", "start 2", "reply 2"]);
  });

  test("forks a long transcript without blocking the daemon's event loop", async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "claude-rewind-long-"));
    const projectDir = path.join(tempRoot, "projects", "-repo");
    mkdirSync(projectDir, { recursive: true });
    const sessionId = randomUUID();
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const turns = 43_000;
    const lastUser = writeLongTranscript(transcriptPath, sessionId, turns);

    const { result: fork, blockingMs } = await measureMainThreadWork(
      "claude fork main-thread work",
      () => realClaudeRewindSdk.forkSession(sessionId, { upToMessageId: lastUser, transcriptPath }),
    );

    expect(blockingMs).toBeLessThan(50);
    const forkLines = readFileSync(path.join(projectDir, `${fork.sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n");
    expect(forkLines).toHaveLength(turns * 2);
    expect(JSON.parse(forkLines[turns * 2 - 2]!).forkedFrom).toEqual({
      sessionId,
      messageUuid: lastUser,
    });
  });
});

describe("Claude project folder session store", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  test("appends entries after existing ones, byte for byte, and loads them back", async () => {
    root = mkdtempSync(path.join(tmpdir(), "claude-rewind-store-"));
    const store = projectFolderSessionStore(root);
    const key = { projectKey: "-repo", sessionId: randomUUID() };
    const transcriptPath = path.join(root, `${key.sessionId}.jsonl`);
    const existing = { type: "user", uuid: randomUUID(), message: { content: "already there" } };
    writeFileSync(transcriptPath, `${JSON.stringify(existing)}\n`);
    const entries = Array.from({ length: 4_000 }, (_, index) => ({
      type: "assistant",
      uuid: randomUUID(),
      message: { content: `reply ${index} ✓ ${"x".repeat(1_000)}` },
    }));

    await store.append(key, entries);

    expect(readFileSync(transcriptPath, "utf8")).toBe(
      [existing, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
    expect(await store.load(key)).toEqual([existing, ...entries]);
  });
});

function writeLongTranscript(transcriptPath: string, sessionId: string, turns: number): string {
  const toolOutput = 'line 1: "quoted" output\twith\\escapes\n'.repeat(4);
  const lines: TranscriptLine[] = [];
  let parentUuid: string | null = null;
  let lastUser = "";
  for (let turn = 0; turn < turns; turn++) {
    lastUser = randomUUID();
    const reply = randomUUID();
    lines.push({ type: "user", uuid: lastUser, parentUuid, text: `question ${turn}` });
    lines.push({ type: "assistant", uuid: reply, parentUuid: lastUser, text: toolOutput });
    parentUuid = reply;
  }
  writeTranscript(transcriptPath, sessionId, lines);
  return lastUser;
}

test.runIf(process.platform === "linux")(
  "releases the transcript descriptor after an early steer match",
  async () => {
    const artifacts = path.resolve(".artifacts");
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(path.join(artifacts, "claude-rewind-descriptor-"));
    const transcriptPath = path.join(root, "session.jsonl");
    const matchingEntry = {
      type: "attachment",
      parentUuid: "before-steer",
      attachment: { type: "queued_command", source_uuid: "steered-message" },
    };
    const unreadEntry = JSON.stringify({ type: "assistant", message: "x".repeat(1024) });
    writeFileSync(
      transcriptPath,
      JSON.stringify(matchingEntry) + "\n" + (unreadEntry + "\n").repeat(1200),
    );
    const openDescriptors = () =>
      readdirSync("/proc/self/fd").filter((descriptor) => {
        try {
          return readlinkSync(path.join("/proc/self/fd", descriptor)) === transcriptPath;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }).length;
    try {
      expect(openDescriptors()).toBe(0);
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(findSteeredMessageParent(transcriptPath, "steered-message")).resolves.toBe(
          "before-steer",
        );
      }
      await expect.poll(openDescriptors, { timeout: 1000 }).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
