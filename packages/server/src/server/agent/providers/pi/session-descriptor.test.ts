import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";

import {
  copyPiSessionFileWithCwd,
  listPiImportableSessions,
  readPiImportSessionConfig,
} from "./session-descriptor.js";

async function writeSession(root: string, lines: unknown[]): Promise<string> {
  const sessionsDir = path.join(root, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, "2026-06-09T00-00-00-000Z_session.jsonl");
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

test("Pi cwd filtering continues past the global candidate overscan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-cwd-limit-"));
  const sessionsDir = path.join(root, "sessions");
  const requestedCwd = path.join(root, "requested");
  const otherCwd = path.join(root, "other");
  const requestedFile = path.join(sessionsDir, "requested", "requested.jsonl");
  await mkdir(path.dirname(requestedFile), { recursive: true });
  await writeFile(
    requestedFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "requested-session",
      timestamp: "2026-06-01T00:00:00.000Z",
      cwd: requestedCwd,
    })}\n`,
    "utf8",
  );
  await utimes(requestedFile, new Date("2026-06-01"), new Date("2026-06-01"));

  await Promise.all(
    Array.from({ length: 400 }, async (_, index) => {
      const file = path.join(sessionsDir, "other", `${index}.jsonl`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: `other-${index}`,
          timestamp: "2026-06-02T00:00:00.000Z",
          cwd: otherCwd,
        })}\n`,
        "utf8",
      );
      await utimes(file, new Date("2026-06-02"), new Date("2026-06-02"));
    }),
  );

  await expect(
    listPiImportableSessions({ sessionDir: sessionsDir, cwd: requestedCwd, limit: 1 }),
  ).resolves.toEqual([
    expect.objectContaining({ providerHandleId: requestedFile, cwd: requestedCwd }),
  ]);
});

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

test("a Pi session copy names the new cwd in its header and keeps every later byte", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-copy-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const header = {
    type: "session",
    version: 3,
    id: "pi-session-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: path.join(root, "removed-worktree"),
  };
  const body = Buffer.from(
    Array.from(
      { length: 2_000 },
      (_, index) =>
        `${JSON.stringify({ type: "message", id: `entry-${index}`, message: { role: "user", content: `café ☕ ${index}` } })}\n`,
    ).join(""),
  );
  expect(body.length).toBeGreaterThan(64 * 1024);
  const sourceFile = path.join(root, "source.jsonl");
  const targetFile = path.join(root, "copy.jsonl");
  await writeFile(sourceFile, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), body]));

  await copyPiSessionFileWithCwd({ sourceFile, targetFile, cwd: "/home/user" });

  const copy = await readFile(targetFile);
  const headerEnd = copy.indexOf(0x0a);
  expect(JSON.parse(copy.subarray(0, headerEnd).toString("utf8"))).toEqual({
    ...header,
    cwd: "/home/user",
  });
  expect(copy.subarray(headerEnd + 1).equals(body)).toBe(true);
});

test("a Pi session copy refuses a file without a session header", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-copy-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, "source.jsonl");
  await writeFile(sourceFile, `${JSON.stringify({ type: "message", id: "entry-1" })}\n`);

  await expect(
    copyPiSessionFileWithCwd({ sourceFile, targetFile: path.join(root, "copy.jsonl"), cwd: "/" }),
  ).rejects.toThrow(`Pi session file has no session header: ${sourceFile}`);
});

const COPY_BODY = [
  { type: "message", id: "entry-1", message: { role: "user", content: "café ☕" } },
  { type: "message", id: "entry-2", message: { role: "assistant", content: "Dans la cuisine." } },
]
  .map((entry) => `${JSON.stringify(entry)}\n`)
  .join("");

const COPY_HEADER = {
  type: "session",
  version: 3,
  id: "pi-session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/removed-worktree",
};

async function copySessionContent(content: string): Promise<Buffer> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-copy-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, "source.jsonl");
  const targetFile = path.join(root, "copy.jsonl");
  await writeFile(sourceFile, content);
  await copyPiSessionFileWithCwd({ sourceFile, targetFile, cwd: "/home/user" });
  return readFile(targetFile);
}

test.each([
  ["a header line longer than 64 KiB", "", { ...COPY_HEADER, padding: "x".repeat(70 * 1024) }],
  ["a header with an empty cwd", "", { ...COPY_HEADER, cwd: "" }],
  ["blank lines before the header", "\n\r\n", COPY_HEADER],
])("a Pi session copy accepts %s", async (_headerShape, prefix, header) => {
  const copy = await copySessionContent(`${prefix}${JSON.stringify(header)}\n${COPY_BODY}`);

  const headerEnd = copy.indexOf(0x0a);
  expect(JSON.parse(copy.subarray(0, headerEnd).toString("utf8"))).toEqual({
    ...header,
    cwd: "/home/user",
  });
  expect(copy.subarray(headerEnd + 1).equals(Buffer.from(COPY_BODY))).toBe(true);
});

test("a Pi session copy reports a missing session file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-session-copy-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, "missing.jsonl");

  await expect(
    copyPiSessionFileWithCwd({ sourceFile, targetFile: path.join(root, "copy.jsonl"), cwd: "/" }),
  ).rejects.toThrow(`Pi session file is missing: ${sourceFile}`);
});
