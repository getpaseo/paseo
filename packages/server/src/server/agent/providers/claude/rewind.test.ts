import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test } from "vitest";

import {
  realClaudeRewindSdk,
  revertClaudeConversation,
  revertClaudeConversationAndFiles,
  revertClaudeFiles,
} from "./rewind.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";

const cleanupPaths = new Set<string>();
const compactedFixture = {
  sourceSessionId: "10000000-0000-4000-8000-000000000001",
  headUuid: "10000000-0000-4000-8000-000000000003",
  tailUuid: "10000000-0000-4000-8000-000000000004",
  anchorUuid: "10000000-0000-4000-8000-000000000006",
  targetUuid: "10000000-0000-4000-8000-000000000007",
  nonMessageUuid: "10000000-0000-4000-8000-000000000008",
} as const;
const compactedFixturePath = join(import.meta.dirname, "test-fixtures", "compacted-session.jsonl");

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupPaths, (cleanupPath) => rm(cleanupPath, { force: true, recursive: true })),
  );
  cleanupPaths.clear();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTranscript(raw: string): Record<string, unknown>[] {
  return raw
    .trim()
    .split("\n")
    .map((line) => {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry)) {
        throw new Error("Expected Claude transcript entry to be an object");
      }
      return entry;
    });
}

function findForkedUuid(entries: Record<string, unknown>[], sourceUuid: string): string {
  for (const entry of entries) {
    const forkedFrom = entry["forkedFrom"];
    if (!isRecord(forkedFrom) || forkedFrom["messageUuid"] !== sourceUuid) {
      continue;
    }
    const uuid = entry["uuid"];
    if (typeof uuid !== "string") {
      throw new Error(`Forked transcript entry for ${sourceUuid} has no UUID`);
    }
    return uuid;
  }
  throw new Error(`Forked transcript has no entry for ${sourceUuid}`);
}

describe("Claude rewind", () => {
  test("forks the conversation up to the user message", async () => {
    const claude = new FakeClaudeSdk();
    let sessionId = "original-session";

    await revertClaudeConversation({
      sdk: claude,
      sessionId,
      cwd: "/workspace",
      messageId: "user-message-1",
      setSessionId: (nextSessionId) => {
        sessionId = nextSessionId;
      },
    });

    expect(claude.recordedForks).toEqual([{ upToMessageId: "user-message-1", dir: "/workspace" }]);
    expect(sessionId).toBe("forked-session-1");
  });

  test("translates Paseo timeline message ids before forking", async () => {
    const claude = new FakeClaudeSdk();
    let sessionId = "original-session";

    await revertClaudeConversation({
      sdk: claude,
      sessionId,
      cwd: "/workspace",
      messageId: "timeline-message-1",
      resolveMessageId: () => "claude-jsonl-message-1",
      setSessionId: (nextSessionId) => {
        sessionId = nextSessionId;
      },
    });

    expect(claude.recordedForks).toEqual([
      { upToMessageId: "claude-jsonl-message-1", dir: "/workspace" },
    ]);
    expect(sessionId).toBe("forked-session-1");
  });

  test("preserves compacted context boundaries when forking", async () => {
    const workspace = join(homedir(), `.paseo-claude-rewind-test-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    const projectDir = claudeProjectDirSync(workspace);
    cleanupPaths.add(projectDir);
    cleanupPaths.add(workspace);
    await mkdir(projectDir, { recursive: true });
    const sourcePath = join(projectDir, `${compactedFixture.sourceSessionId}.jsonl`);
    await writeFile(sourcePath, await readFile(compactedFixturePath), { mode: 0o600 });
    let sessionId = compactedFixture.sourceSessionId;

    await revertClaudeConversation({
      sdk: realClaudeRewindSdk,
      sessionId,
      cwd: workspace,
      messageId: compactedFixture.targetUuid,
      setSessionId: (nextSessionId) => {
        sessionId = nextSessionId;
      },
    });

    const forkedPath = join(projectDir, `${sessionId}.jsonl`);
    const forkedEntries = parseTranscript(await readFile(forkedPath, "utf8"));
    const forkedBoundary = forkedEntries.find((entry) => entry["subtype"] === "compact_boundary");
    expect(forkedBoundary).toMatchObject({
      compactMetadata: {
        preservedSegment: {
          headUuid: findForkedUuid(forkedEntries, compactedFixture.headUuid),
          anchorUuid: findForkedUuid(forkedEntries, compactedFixture.anchorUuid),
          tailUuid: findForkedUuid(forkedEntries, compactedFixture.tailUuid),
        },
        preservedMessages: {
          anchorUuid: findForkedUuid(forkedEntries, compactedFixture.anchorUuid),
          uuids: [
            findForkedUuid(forkedEntries, compactedFixture.headUuid),
            findForkedUuid(forkedEntries, compactedFixture.tailUuid),
          ],
          allUuids: [
            findForkedUuid(forkedEntries, compactedFixture.headUuid),
            compactedFixture.nonMessageUuid,
            findForkedUuid(forkedEntries, compactedFixture.tailUuid),
          ],
        },
      },
    });
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
      cwd: "/workspace",
      messageId: "user-message-1",
      setSessionId: (nextSessionId) => {
        sessionId = nextSessionId;
      },
    });

    expect(claude.recordedFileRewinds).toEqual([{ userMessageId: "user-message-1" }]);
    expect(claude.recordedForks).toEqual([{ upToMessageId: "user-message-1", dir: "/workspace" }]);
    expect(sessionId).toBe("forked-before-rehydrate");
  });
});
