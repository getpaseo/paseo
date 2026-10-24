import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  listOmpImportableSessions,
  readOmpImportSessionConfig,
  resolveOmpSessionFile,
} from "./session-descriptor.js";

async function writeSession(root: string, relativePath: string, lines: unknown[]): Promise<string> {
  const filePath = path.join(root, "sessions", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

describe("OMP session descriptor", () => {
  test("cwd filtering continues past the global candidate overscan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-cwd-limit-"));
    const sessionsDir = path.join(root, "sessions");
    const requestedCwd = path.join(root, "requested");
    const otherCwd = path.join(root, "other");
    const requestedFile = await writeSession(root, "requested/requested.jsonl", [
      {
        type: "session",
        id: "requested-session",
        timestamp: "2026-06-01T00:00:00.000Z",
        cwd: requestedCwd,
      },
    ]);
    await utimes(requestedFile, new Date("2026-06-01"), new Date("2026-06-01"));

    await Promise.all(
      Array.from({ length: 400 }, async (_, index) => {
        const file = await writeSession(root, `other/${index}.jsonl`, [
          {
            type: "session",
            id: `other-${index}`,
            timestamp: "2026-06-02T00:00:00.000Z",
            cwd: otherCwd,
          },
        ]);
        await utimes(file, new Date("2026-06-02"), new Date("2026-06-02"));
      }),
    );

    await expect(
      listOmpImportableSessions({ sessionDir: sessionsDir, cwd: requestedCwd, limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({ providerHandleId: requestedFile, cwd: requestedCwd }),
    ]);
  });

  test("reads title-first sessions and OMP combined model identifiers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-title-first-"));
    const cwd = path.join(root, "repo");
    const sessionFile = await writeSession(root, "project/session.jsonl", [
      {
        type: "title",
        id: "title-1",
        timestamp: "2026-06-09T00:00:00.000Z",
        title: "Deploy Paseo and verify",
      },
      {
        type: "session",
        version: 3,
        id: "session-title-first",
        timestamp: "2026-06-09T00:00:00.100Z",
        cwd,
      },
      {
        type: "model_change",
        id: "model-1",
        timestamp: "2026-06-09T00:00:00.200Z",
        model: "openai-codex/gpt-5.1",
      },
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-06-09T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "import me" }] },
      },
    ]);

    await expect(
      listOmpImportableSessions({ sessionDir: path.join(root, "sessions") }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerHandleId: sessionFile,
        cwd,
        title: "Deploy Paseo and verify",
        firstPromptPreview: "import me",
      }),
    ]);
    await expect(readOmpImportSessionConfig(sessionFile)).resolves.toEqual({
      model: "openai-codex/gpt-5.1",
    });
  });

  test("resolves a bare session id to its file and reads the same import config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-by-id-"));
    const sessionDir = path.join(root, "sessions");
    const cwd = path.join(root, "repo");
    const sessionId = "01a03dc8-77bb-7000-b0a3-bb7d25477e81";
    const sessionFile = await writeSession(
      root,
      `project/2026-08-26T11-15-43-163Z_${sessionId}.jsonl`,
      [
        { type: "title", v: 1, title: "", updatedAt: "2026-08-26T11:15:43.163Z" },
        { type: "session", version: 3, id: sessionId, timestamp: "2026-08-26T11:15:43.163Z", cwd },
        {
          type: "model_change",
          id: "model-1",
          timestamp: "2026-08-26T11:15:43.200Z",
          model: "anthropic/claude-opus-5",
        },
      ],
    );
    // A decoy whose filename does not follow the `<timestamp>_<id>` convention
    // but whose header carries the id must still be found.
    const oddlyNamedId = "renamed-session";
    const oddlyNamed = await writeSession(root, "project/notes.jsonl", [
      { type: "session", id: oddlyNamedId, timestamp: "2026-08-27T00:00:00.000Z", cwd },
      {
        type: "model_change",
        id: "model-2",
        timestamp: "2026-08-27T00:00:00.100Z",
        model: "mimorouter/claude-fable-5-1",
      },
    ]);

    await expect(resolveOmpSessionFile(sessionId, { sessionDir })).resolves.toBe(sessionFile);
    await expect(resolveOmpSessionFile(sessionFile, { sessionDir })).resolves.toBe(sessionFile);
    await expect(resolveOmpSessionFile(oddlyNamedId, { sessionDir })).resolves.toBe(oddlyNamed);
    await expect(resolveOmpSessionFile("does-not-exist", { sessionDir })).resolves.toBeNull();

    const byId = await readOmpImportSessionConfig(sessionId, { sessionDir });
    const byPath = await readOmpImportSessionConfig(sessionFile, { sessionDir });
    expect(byId).toEqual({ model: "anthropic/claude-opus-5" });
    expect(byId).toEqual(byPath);
    await expect(readOmpImportSessionConfig("does-not-exist", { sessionDir })).resolves.toEqual({});
  });

  test("keeps recent nested OMP subagent sessions importable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-nested-"));
    const cwd = path.join(root, "repo");
    const parent = await writeSession(root, "project/parent.jsonl", [
      { type: "session", id: "parent", timestamp: "2026-06-10T00:00:00.000Z", cwd },
      {
        type: "message",
        id: "parent-user",
        timestamp: "2026-06-10T00:00:01.000Z",
        message: { role: "user", content: "parent prompt" },
      },
    ]);
    const child = await writeSession(root, "project/parent/Explore.jsonl", [
      { type: "session", id: "child", timestamp: "2026-06-09T00:00:00.000Z", cwd },
      {
        type: "message",
        id: "child-user",
        timestamp: "2026-06-09T00:00:01.000Z",
        message: { role: "user", content: "child prompt" },
      },
    ]);
    await utimes(parent, new Date("2026-06-08"), new Date("2026-06-08"));
    await utimes(child, new Date("2026-06-09"), new Date("2026-06-09"));

    await expect(
      listOmpImportableSessions({ sessionDir: path.join(root, "sessions"), limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerHandleId: child,
        title: "Explore",
        firstPromptPreview: "child prompt",
      }),
    ]);
  });

  test("uses OMP's own default session directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-home-"));
    const cwd = path.join(home, "repo");
    const sessionFile = path.join(home, ".omp", "agent", "sessions", "project", "session.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", id: "default-dir", timestamp: "2026-06-09", cwd })}\n`,
      "utf8",
    );

    await expect(listOmpImportableSessions({ homeDir: home, env: {} })).resolves.toEqual([
      expect.objectContaining({ providerHandleId: sessionFile, cwd }),
    ]);
  });

  test("uses a named OMP profile's session directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-omp-profile-home-"));
    const cwd = path.join(home, "repo");
    const sessionFile = path.join(
      home,
      ".omp",
      "profiles",
      "qa",
      "agent",
      "sessions",
      "project",
      "profile.jsonl",
    );
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ type: "session", id: "qa-profile", cwd }));

    await expect(
      listOmpImportableSessions({
        homeDir: home,
        env: {},
        runtimeSettings: { env: { OMP_PROFILE: "qa" } },
      }),
    ).resolves.toEqual([expect.objectContaining({ providerHandleId: sessionFile })]);
  });

  test.skipIf(process.platform === "win32")(
    "uses a profile's XDG data directory after OMP has created it",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-omp-xdg-home-"));
      const cwd = path.join(home, "repo");
      const xdgDataHome = path.join(home, "xdg-data");
      const sessionFile = path.join(
        xdgDataHome,
        "omp",
        "profiles",
        "qa",
        "sessions",
        "project",
        "session.jsonl",
      );
      await mkdir(path.dirname(sessionFile), { recursive: true });
      await writeFile(sessionFile, JSON.stringify({ type: "session", id: "xdg-profile", cwd }));

      await expect(
        listOmpImportableSessions({
          homeDir: home,
          env: { OMP_PROFILE: "qa", XDG_DATA_HOME: xdgDataHome },
        }),
      ).resolves.toEqual([expect.objectContaining({ providerHandleId: sessionFile })]);
    },
  );

  test.runIf(process.platform === "win32")(
    "ignores a profile's XDG data directory on Windows",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "paseo-omp-windows-xdg-home-"));
      const cwd = path.join(home, "repo");
      const xdgDataHome = path.join(home, "xdg-data");
      const xdgSessionFile = path.join(
        xdgDataHome,
        "omp",
        "profiles",
        "qa",
        "sessions",
        "project",
        "xdg.jsonl",
      );
      const profileSessionFile = path.join(
        home,
        ".omp",
        "profiles",
        "qa",
        "agent",
        "sessions",
        "project",
        "profile.jsonl",
      );
      await Promise.all([
        mkdir(path.dirname(xdgSessionFile), { recursive: true }),
        mkdir(path.dirname(profileSessionFile), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(xdgSessionFile, JSON.stringify({ type: "session", id: "xdg-profile", cwd })),
        writeFile(profileSessionFile, JSON.stringify({ type: "session", id: "qa-profile", cwd })),
      ]);

      await expect(
        listOmpImportableSessions({
          homeDir: home,
          env: { OMP_PROFILE: "qa", XDG_DATA_HOME: xdgDataHome },
        }),
      ).resolves.toEqual([expect.objectContaining({ providerHandleId: profileSessionFile })]);
    },
  );
});

test("cwd filtering does not read unrelated session tails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-cwd-reads-"));
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
    const sessions = await listOmpImportableSessions(
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
  const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-filter-metadata-"));
  try {
    const sessionsDir = path.join(root, "custom-sessions");
    const cwd = path.join(root, "workspace");
    await mkdir(sessionsDir);
    const olderActivity = path.join(sessionsDir, "older.jsonl");
    const latestActivity = path.join(sessionsDir, "latest.jsonl");
    const rows = [
      { type: "title", title: "initial title" },
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
    const sessions = await listOmpImportableSessions({ sessionDir: sessionsDir, cwd, limit: 2 });
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
    expect(await readOmpImportSessionConfig(olderActivity)).toEqual({
      model: "test/latest",
      thinkingOptionId: "high",
    });
    expect(await readOmpImportSessionConfig(path.join(root, "missing.jsonl"))).toEqual({});
    expect(
      await listOmpImportableSessions({ sessionDir: path.join(root, "missing"), cwd }),
    ).toEqual([]);
    expect(
      (await listOmpImportableSessions({ sessionDir: sessionsDir, cwd, limit: 1 })).map(
        (session) => session.providerHandleId,
      ),
    ).toEqual([olderActivity]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("workspace filtering accepts a symlink cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-filter-symlink-"));
  try {
    const sessionsDir = path.join(root, "sessions");
    const cwd = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    await mkdir(cwd);
    await mkdir(sessionsDir);
    await symlink(cwd, alias);
    const file = path.join(sessionsDir, "session.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", id: "symlink", cwd }));
    const sessions = await listOmpImportableSessions({ sessionDir: sessionsDir, cwd: alias });
    expect(sessions).toEqual([expect.objectContaining({ providerHandleId: file, cwd })]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
