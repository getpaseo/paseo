import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

test("cwd filtering does not read unrelated session tails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-cwd-reads-"));
  try {
    const sessionsDir = path.join(root, "sessions");
    const cwd = path.join(root, "requested");
    await mkdir(sessionsDir);
    const requested = path.join(sessionsDir, "requested.jsonl");
    const unrelated = path.join(sessionsDir, "unrelated.jsonl");
    for (const [file, sessionCwd] of [
      [requested, cwd],
      [unrelated, path.join(root, "other")],
    ]) {
      await writeFile(
        file,
        [
          JSON.stringify({ type: "session", id: path.basename(file), cwd: sessionCwd }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-06-09T00:00:01Z",
            message: { role: "user", content: "hello" },
          }),
        ].join("\n"),
      );
    }
    await utimes(unrelated, new Date("2026-06-10"), new Date("2026-06-10"));
    await utimes(requested, new Date("2026-06-09"), new Date("2026-06-09"));
    const tailReads: string[] = [];
    const reader = {
      readHead: async (file: string) =>
        (await readFile(file)).subarray(0, 64 * 1024).toString("utf8"),
      readTail: async (file: string) => {
        tailReads.push(file);
        return (await readFile(file)).subarray(-256 * 1024).toString("utf8");
      },
    };
    const sessions = await listPiImportableSessions(
      { sessionDir: sessionsDir, cwd, limit: 1 },
      reader,
    );
    expect(sessions).toEqual([
      expect.objectContaining({
        providerHandleId: requested,
        cwd,
        firstPromptPreview: "hello",
        lastPromptPreview: "hello",
      }),
    ]);
    expect(tailReads).toEqual([requested]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace filtering preserves large-session metadata and malformed-file handling", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-filter-metadata-"));
  try {
    const sessionsDir = path.join(root, "custom-sessions");
    const cwd = path.join(root, "workspace");
    await mkdir(sessionsDir);
    const olderActivity = path.join(sessionsDir, "older.jsonl");
    const latestActivity = path.join(sessionsDir, "latest.jsonl");
    const rows = [
      { type: "session", id: "large", cwd, timestamp: "2026-06-01T00:00:00Z" },
      {
        type: "message",
        timestamp: "2026-06-01T00:00:01Z",
        message: { role: "user", content: "first prompt" },
      },
      { type: "message", message: { role: "assistant", content: "x".repeat(512 * 1024) } },
      { type: "session_info", name: "latest title" },
      { type: "model_change", provider: "test", modelId: "latest" },
      { type: "thinking_level_change", thinkingLevel: "high" },
      {
        type: "message",
        timestamp: "2026-06-09T00:00:00Z",
        message: { role: "user", content: "last prompt" },
      },
    ];
    await writeFile(olderActivity, rows.map((row) => JSON.stringify(row)).join("\n"));
    await writeFile(
      latestActivity,
      [
        { type: "session", id: "latest", cwd },
        {
          type: "message",
          timestamp: "2026-06-10T00:00:00Z",
          message: { role: "user", content: "newer activity" },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    await writeFile(path.join(sessionsDir, "malformed.jsonl"), "not json\n{}");
    await writeFile(
      path.join(sessionsDir, "missing-header.jsonl"),
      JSON.stringify({ type: "message", message: { role: "user", content: "ignore" } }),
    );
    await utimes(olderActivity, new Date("2026-06-12"), new Date("2026-06-12"));
    await utimes(latestActivity, new Date("2026-06-11"), new Date("2026-06-11"));
    const sessions = await listPiImportableSessions({ sessionDir: sessionsDir, cwd, limit: 2 });
    expect(sessions.map((session) => session.providerHandleId)).toEqual([
      latestActivity,
      olderActivity,
    ]);
    expect(sessions[1]).toEqual({
      providerHandleId: olderActivity,
      cwd,
      title: "latest title",
      firstPromptPreview: "first prompt",
      lastPromptPreview: "last prompt",
      lastActivityAt: new Date("2026-06-09T00:00:00Z"),
    });
    expect(await readPiImportSessionConfig(olderActivity)).toEqual({
      model: "test/latest",
      thinkingOptionId: "high",
    });
    expect(await readPiImportSessionConfig(path.join(root, "missing.jsonl"))).toEqual({});
    expect(await listPiImportableSessions({ sessionDir: path.join(root, "missing"), cwd })).toEqual(
      [],
    );
    expect(
      (await listPiImportableSessions({ sessionDir: sessionsDir, cwd, limit: 1 })).map(
        (session) => session.providerHandleId,
      ),
    ).toEqual([olderActivity]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("workspace filtering accepts a symlink cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-pi-filter-symlink-"));
  try {
    const sessionsDir = path.join(root, "sessions");
    const cwd = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    await mkdir(cwd);
    await mkdir(sessionsDir);
    await symlink(cwd, alias);
    const file = path.join(sessionsDir, "session.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", id: "symlink", cwd }));
    const sessions = await listPiImportableSessions({ sessionDir: sessionsDir, cwd: alias });
    expect(sessions).toEqual([expect.objectContaining({ providerHandleId: file, cwd })]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
