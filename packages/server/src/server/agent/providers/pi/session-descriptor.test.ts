import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { listPiImportableSessions, readPiImportSessionConfig } from "./session-descriptor.js";

async function writeSession(root: string, lines: unknown[]): Promise<string> {
  const sessionsDir = path.join(root, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, "2026-06-09T00-00-00-000Z_session.jsonl");
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

async function writeNamedSession(
  root: string,
  cwdDir: string,
  fileName: string,
  lines: unknown[],
  nestedDir?: string,
): Promise<string> {
  const sessionsDir = nestedDir
    ? path.join(root, "sessions", cwdDir, nestedDir)
    : path.join(root, "sessions", cwdDir);
  await mkdir(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, fileName);
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

function sessionHeader(id: string, cwd: string, timestamp: string) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd,
  };
}

function userMessage(id: string, timestamp: string, text: string) {
  return {
    type: "message",
    id,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}


test("Pi import config preserves the latest recorded model and thinking level", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-model-"));
  const cwd = path.join(root, "repo");
  const sessionFile = await writeSession(root, [
    {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-06-09T00:00:00.000Z",
      cwd,
    },
    {
      type: "model_change",
      id: "model-1",
      timestamp: "2026-06-09T00:00:01.000Z",
      provider: "openai-codex",
      modelId: "gpt-5.1",
    },
    {
      type: "thinking_level_change",
      id: "thinking-1",
      timestamp: "2026-06-09T00:00:01.500Z",
      thinkingLevel: "low",
    },
    {
      type: "message",
      id: "user-1",
      timestamp: "2026-06-09T00:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    },
    {
      type: "model_change",
      id: "model-2",
      timestamp: "2026-06-09T00:00:03.000Z",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
    },
    {
      type: "thinking_level_change",
      id: "thinking-2",
      timestamp: "2026-06-09T00:00:04.000Z",
      thinkingLevel: "high",
    },
  ]);

  const [descriptor] = await listPiImportableSessions({ sessionDir: path.join(root, "sessions") });
  const importConfig = await readPiImportSessionConfig(sessionFile);

  expect(descriptor).toMatchObject({
    providerHandleId: sessionFile,
    cwd,
    firstPromptPreview: "hello",
  });
  expect(importConfig).toEqual({
    model: "openrouter/anthropic/claude-sonnet-4.5",
    thinkingOptionId: "high",
  });
});

test("Pi import config can infer model from assistant messages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-message-model-"));
  const cwd = path.join(root, "repo");
  const sessionFile = await writeSession(root, [
    {
      type: "session",
      version: 3,
      id: "session-2",
      timestamp: "2026-06-09T00:00:00.000Z",
      cwd,
    },
    {
      type: "message",
      id: "user-1",
      timestamp: "2026-06-09T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    },
    {
      type: "message",
      id: "assistant-1",
      timestamp: "2026-06-09T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        provider: "google",
        model: "gemini-2.5-pro",
      },
    },
  ]);

  const importConfig = await readPiImportSessionConfig(sessionFile);

  expect(importConfig).toEqual({
    model: "google/gemini-2.5-pro",
  });
});

test("Pi import config preserves thinking before a later model in large sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-large-thinking-"));
  const cwd = path.join(root, "repo");
  const fillerMessages = Array.from({ length: 2_100 }, (_, index) => ({
    type: "message",
    id: `filler-${index}`,
    timestamp: `2026-06-09T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `filler ${index}` }],
    },
  }));
  const sessionFile = await writeSession(root, [
    {
      type: "session",
      version: 3,
      id: "session-3",
      timestamp: "2026-06-09T00:00:00.000Z",
      cwd,
    },
    {
      type: "message",
      id: "user-1",
      timestamp: "2026-06-09T00:00:01.000Z",
      message: { role: "user", content: "hello" },
    },
    ...fillerMessages,
    {
      type: "thinking_level_change",
      id: "thinking-1",
      timestamp: "2026-06-09T01:00:00.000Z",
      thinkingLevel: "low",
    },
    {
      type: "model_change",
      id: "model-1",
      timestamp: "2026-06-09T01:00:01.000Z",
      provider: "openrouter",
      modelId: "google/gemini-2.5-pro",
    },
    {
      type: "session_info",
      id: "info-1",
      timestamp: "2026-06-09T01:00:02.000Z",
      name: "large session",
    },
  ]);

  const importConfig = await readPiImportSessionConfig(sessionFile);

  expect(importConfig).toEqual({
    model: "openrouter/google/gemini-2.5-pro",
    thinkingOptionId: "low",
  });
});

test("Pi import listing skips nested subagent transcripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-skip-nested-"));
  const cwd = path.join(root, "repo");
  const parent = await writeNamedSession(
    root,
    "project",
    "2026-06-09T00-00-00-000Z_parent.jsonl",
    [
      sessionHeader("parent-1", cwd, "2026-06-09T00:00:00.000Z"),
      userMessage("user-1", "2026-06-09T00:00:01.000Z", "parent prompt"),
    ],
  );
  await writeNamedSession(
    root,
    "project",
    "subagent.jsonl",
    [
      sessionHeader("subagent-1", cwd, "2026-06-09T00:00:02.000Z"),
      userMessage("user-2", "2026-06-09T00:00:03.000Z", "nested subagent prompt"),
    ],
    "2026-06-09T00-00-00-000Z_parent",
  );

  const sessions = await listPiImportableSessions({ sessionDir: path.join(root, "sessions") });

  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    providerHandleId: parent,
    cwd,
    firstPromptPreview: "parent prompt",
  });
});

test("OMP import listing accepts title-first session headers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-title-first-"));
  const cwd = path.join(root, "repo");
  const sessionFile = await writeNamedSession(
    root,
    "project",
    "2026-06-09T00-00-00-000Z_title_first.jsonl",
    [
      {
        type: "title",
        id: "title-1",
        timestamp: "2026-06-09T00:00:00.000Z",
        title: "Deploy paseo and verify",
      },
      sessionHeader("session-title-first", cwd, "2026-06-09T00:00:00.100Z"),
      {
        type: "model_change",
        id: "model-1",
        timestamp: "2026-06-09T00:00:00.200Z",
        model: "openai-codex/gpt-5.1",
      },
      userMessage("user-1", "2026-06-09T00:00:01.000Z", "import me"),
    ],
  );

  const sessions = await listPiImportableSessions({ sessionDir: path.join(root, "sessions") });
  const importConfig = await readPiImportSessionConfig(sessionFile);

  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    providerHandleId: sessionFile,
    cwd,
    title: "Deploy paseo and verify",
    firstPromptPreview: "import me",
  });
  expect(importConfig).toEqual({
    model: "openai-codex/gpt-5.1",
  });
});

test("Pi import listing prefers recent parent sessions without scanning nested trees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-recent-limit-"));
  const cwd = path.join(root, "repo");
  const older = await writeNamedSession(
    root,
    "project",
    "2026-06-08T00-00-00-000Z_old.jsonl",
    [
      sessionHeader("old-session", cwd, "2026-06-08T00:00:00.000Z"),
      userMessage("user-old", "2026-06-08T00:00:01.000Z", "old prompt"),
    ],
  );
  const newer = await writeNamedSession(
    root,
    "project",
    "2026-06-09T00-00-00-000Z_new.jsonl",
    [
      sessionHeader("new-session", cwd, "2026-06-09T00:00:00.000Z"),
      userMessage("user-new", "2026-06-09T00:00:01.000Z", "new prompt"),
    ],
  );
  // Nested noise should never appear in the importable list.
  await writeNamedSession(
    root,
    "project",
    "noise.jsonl",
    [
      sessionHeader("noise-session", cwd, "2026-06-09T12:00:00.000Z"),
      userMessage("user-noise", "2026-06-09T12:00:01.000Z", "noise prompt"),
    ],
    "2026-06-09T00-00-00-000Z_new",
  );

  // Ensure mtime ordering is deterministic across filesystems.
  const { utimes } = await import("node:fs/promises");
  await utimes(older, new Date("2026-06-08T00:00:00.000Z"), new Date("2026-06-08T00:00:00.000Z"));
  await utimes(newer, new Date("2026-06-09T00:00:00.000Z"), new Date("2026-06-09T00:00:00.000Z"));

  const sessions = await listPiImportableSessions({
    sessionDir: path.join(root, "sessions"),
    limit: 1,
  });

  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    providerHandleId: newer,
    firstPromptPreview: "new prompt",
  });
});
