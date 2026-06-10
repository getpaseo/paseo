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
