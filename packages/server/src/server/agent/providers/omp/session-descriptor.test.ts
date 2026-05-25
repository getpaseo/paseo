import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { listOmpPersistedAgents } from "./session-descriptor.js";

const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-omp-sessions-"));
}

function writeJsonl(filePath: string, entries: unknown[]): string {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return filePath;
}

function ompSession(overrides: {
  id: string;
  cwd: string;
  timestamp?: string;
  entries?: unknown[];
}): unknown[] {
  return [
    {
      type: "session",
      version: 3,
      id: overrides.id,
      timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
      cwd: overrides.cwd,
    },
    ...(overrides.entries ?? []),
  ];
}

function message(input: {
  role: "user" | "assistant";
  content: unknown;
  timestamp: string;
}): unknown {
  return {
    type: "message",
    id: `entry-${input.timestamp}`,
    parentId: null,
    timestamp: input.timestamp,
    message: {
      role: input.role,
      content: input.content,
    },
  };
}

function sessionInfo(name: string, timestamp: string): unknown {
  return {
    type: "session_info",
    id: `info-${timestamp}`,
    parentId: null,
    timestamp,
    name,
  };
}

describe("listOmpPersistedAgents", () => {
  test("lists OMP sessions from the configured agent dir and stamps provider=omp", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "project");
    const sessionsDir = path.join(root, "agent", "sessions", "--project--");
    const sessionFile = writeJsonl(
      path.join(sessionsDir, "20260101_session-a.jsonl"),
      ompSession({
        id: "session-a",
        cwd,
        entries: [
          message({
            role: "user",
            content: "first prompt",
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
          message({
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
            timestamp: "2026-01-01T00:00:02.000Z",
          }),
          message({
            role: "user",
            content: [{ type: "text", text: "last prompt" }],
            timestamp: "2026-01-01T00:00:03.000Z",
          }),
          sessionInfo("Named OMP Session", "2026-01-01T00:00:10.000Z"),
        ],
      }),
    );

    const descriptors = await listOmpPersistedAgents({
      cwd,
      env: { OMP_CODING_AGENT_DIR: path.join(root, "agent") },
      homeDir: root,
    });

    expect(descriptors).toEqual([
      {
        provider: "omp",
        sessionId: "session-a",
        cwd,
        title: "Named OMP Session",
        lastActivityAt: new Date("2026-01-01T00:00:03.000Z"),
        persistence: {
          provider: "omp",
          sessionId: "session-a",
          nativeHandle: sessionFile,
          metadata: {
            provider: "omp",
            cwd,
          },
        },
        timeline: [
          { type: "user_message", text: "first prompt" },
          { type: "user_message", text: "last prompt" },
        ],
      },
    ]);
  });

  test("falls back to ~/.omp/agent/sessions when no env or settings override is present", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "project");
    const sessionsDir = path.join(root, ".omp", "agent", "sessions");
    writeJsonl(
      path.join(sessionsDir, "default.jsonl"),
      ompSession({
        id: "default-session",
        cwd,
        entries: [
          message({
            role: "user",
            content: "default path",
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
        ],
      }),
    );

    const descriptors = await listOmpPersistedAgents({
      cwd,
      env: {},
      homeDir: root,
    });

    expect(descriptors.map((descriptor) => descriptor.sessionId)).toEqual(["default-session"]);
  });

  test("uses the runtime OMP_CODING_AGENT_SESSION_DIR override before settings", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const runtimeSessionsDir = path.join(root, "runtime-sessions");
    const settingsSessionsDir = path.join(root, "settings-sessions");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ sessionDir: settingsSessionsDir }),
      "utf8",
    );
    writeJsonl(
      path.join(settingsSessionsDir, "ignored.jsonl"),
      ompSession({ id: "settings-session", cwd }),
    );
    writeJsonl(
      path.join(runtimeSessionsDir, "selected.jsonl"),
      ompSession({
        id: "runtime-session",
        cwd,
        entries: [
          message({
            role: "user",
            content: "from runtime dir",
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
        ],
      }),
    );

    const descriptors = await listOmpPersistedAgents({
      cwd,
      runtimeSettings: {
        env: {
          OMP_CODING_AGENT_DIR: agentDir,
          OMP_CODING_AGENT_SESSION_DIR: runtimeSessionsDir,
        },
      },
      env: {},
      homeDir: root,
    });

    expect(descriptors.map((descriptor) => descriptor.sessionId)).toEqual(["runtime-session"]);
  });

  test("resolves project settings sessionDir relative to the requested cwd", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "project");
    const projectSettingsDir = path.join(cwd, ".omp");
    const sessionsDir = path.join(cwd, "relative-sessions");
    mkdirSync(projectSettingsDir, { recursive: true });
    writeFileSync(
      path.join(projectSettingsDir, "settings.json"),
      JSON.stringify({ sessionDir: "relative-sessions" }),
      "utf8",
    );
    writeJsonl(
      path.join(sessionsDir, "relative.jsonl"),
      ompSession({
        id: "relative-session",
        cwd,
        entries: [
          message({
            role: "user",
            content: "relative settings",
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
        ],
      }),
    );

    const descriptors = await listOmpPersistedAgents({
      cwd,
      env: { OMP_CODING_AGENT_DIR: path.join(root, "agent") },
      homeDir: root,
    });

    expect(descriptors.map((descriptor) => descriptor.sessionId)).toEqual(["relative-session"]);
  });

  test("matches sessions stored with the real cwd when the requested cwd is symlinked", async () => {
    const root = tempRoot();
    const realCwd = path.join(root, "real-project");
    const linkedCwd = path.join(root, "linked-project");
    mkdirSync(realCwd, { recursive: true });
    symlinkSync(realCwd, linkedCwd, directorySymlinkType);
    const persistedCwd = realpathSync(linkedCwd);
    const sessionsDir = path.join(root, "agent", "sessions");
    writeJsonl(
      path.join(sessionsDir, "symlinked.jsonl"),
      ompSession({
        id: "symlinked-session",
        cwd: persistedCwd,
        entries: [
          message({
            role: "user",
            content: "through symlink",
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
        ],
      }),
    );

    const descriptors = await listOmpPersistedAgents({
      cwd: linkedCwd,
      env: { OMP_CODING_AGENT_DIR: path.join(root, "agent") },
      homeDir: root,
    });

    expect(descriptors.map((descriptor) => descriptor.sessionId)).toEqual(["symlinked-session"]);
  });

  test("filters by cwd, sorts by activity, and ignores invalid session files", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "project");
    const otherCwd = path.join(root, "other");
    const sessionsDir = path.join(root, "agent", "sessions");
    writeJsonl(
      path.join(sessionsDir, "older.jsonl"),
      ompSession({
        id: "older",
        cwd,
        entries: [
          message({
            role: "user",
            content: "older",
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
        ],
      }),
    );
    writeJsonl(
      path.join(sessionsDir, "newer.jsonl"),
      ompSession({
        id: "newer",
        cwd,
        entries: [
          message({
            role: "user",
            content: "newer",
            timestamp: "2026-01-01T00:00:02.000Z",
          }),
        ],
      }),
    );
    writeJsonl(
      path.join(sessionsDir, "outside.jsonl"),
      ompSession({
        id: "outside",
        cwd: otherCwd,
        entries: [
          message({
            role: "user",
            content: "outside",
            timestamp: "2026-01-01T00:00:03.000Z",
          }),
        ],
      }),
    );
    writeFileSync(path.join(sessionsDir, "broken.jsonl"), '{"type":"nope"}\n', "utf8");

    const descriptors = await listOmpPersistedAgents({
      cwd,
      limit: 1,
      env: { OMP_CODING_AGENT_DIR: path.join(root, "agent") },
      homeDir: root,
    });

    expect(descriptors.map((descriptor) => descriptor.sessionId)).toEqual(["newer"]);
  });

  test("only sees OMP sessions when both ~/.pi and ~/.omp exist", async () => {
    const root = tempRoot();
    const cwd = path.join(root, "project");
    const piSessionsDir = path.join(root, ".pi", "agent", "sessions");
    const ompSessionsDir = path.join(root, ".omp", "agent", "sessions");
    writeJsonl(path.join(piSessionsDir, "pi-only.jsonl"), ompSession({ id: "pi-only", cwd }));
    writeJsonl(path.join(ompSessionsDir, "omp-only.jsonl"), ompSession({ id: "omp-only", cwd }));

    const ompDescriptors = await listOmpPersistedAgents({
      cwd,
      env: {},
      homeDir: root,
    });
    expect(ompDescriptors.map((d) => d.sessionId)).toEqual(["omp-only"]);
    expect(ompDescriptors[0].provider).toBe("omp");
  });
});
