import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pino from "pino";
import type { AgentPersistenceHandle } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

// Archiving a Claude agent archives its Claude Code session through the Agent SDK (an archived.json
// beside the transcript), as Codex archives its thread, and Import session leaves out sessions the
// SDK reports archived. These run the real SDK against a temporary CLAUDE_CONFIG_DIR.

const archivedId = "1b6a1c55-3f3e-4a43-9a7f-0f3f5d1b2c01";
const keptId = "1b6a1c55-3f3e-4a43-9a7f-0f3f5d1b2c02";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-claude-archive-"));
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
let configDir = "";
let project = "";

function userLine(sessionId: string, cwd: string, text: string, timestamp: string, uuid: string) {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid: null,
    sessionId,
    cwd,
    timestamp,
    message: { role: "user", content: text },
  });
}

function writeTranscript(dir: string, sessionId: string, cwd: string, text: string) {
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${userLine(sessionId, cwd, text, "2026-01-01T00:00:00.000Z", `${sessionId.slice(0, -2)}aa`)}\n`,
  );
}

function handle(sessionId: string): AgentPersistenceHandle {
  return {
    provider: "claude",
    sessionId,
    nativeHandle: sessionId,
    metadata: { provider: "claude", cwd: "/work/app" },
  };
}

function client(env?: Record<string, string>) {
  return new ClaudeAgentClient({
    logger: pino({ level: "silent" }),
    ...(env ? { runtimeSettings: { env } } : {}),
  });
}

async function listed(claude: ClaudeAgentClient, options: { cwd?: string } = {}) {
  const sessions = await claude.listImportableSessions({ limit: 10, ...options });
  return sessions.map((session) => session.providerHandleId).sort();
}

const mark = (dir: string, sessionId: string) => path.join(dir, sessionId, "archived.json");
const readMark = (dir: string, sessionId: string) =>
  JSON.parse(fs.readFileSync(mark(dir, sessionId), "utf8")) as { archived: boolean };

describe("Claude native archive", () => {
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(tmp, "claude-"));
    project = path.join(configDir, "projects", "-work-app");
    fs.mkdirSync(project, { recursive: true });
    writeTranscript(project, archivedId, "/work/app", "Archive me");
    writeTranscript(project, keptId, "/work/app", "Keep me");
    // The SDK reads the daemon's own config dir; the provider reads the same one unless its env says otherwise.
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("archiving hides the session from Import session and unarchiving shows it again", async () => {
    const claude = client();
    expect(await listed(claude)).toEqual([archivedId, keptId]);

    await claude.archiveNativeSession(handle(archivedId));
    expect(readMark(project, archivedId).archived).toBe(true);
    expect(await listed(claude)).toEqual([keptId]);

    await claude.unarchiveNativeSession(handle(archivedId));
    expect(readMark(project, archivedId).archived).toBe(false);
    expect(await listed(claude)).toEqual([archivedId, keptId]);
  });

  test("a prompt sent after the archive unarchives the session, as the SDK reports it", async () => {
    const claude = client();
    await claude.archiveNativeSession(handle(archivedId));
    expect(await listed(claude)).toEqual([keptId]);

    const later = new Date(Date.now() + 60_000).toISOString();
    fs.appendFileSync(
      path.join(project, `${archivedId}.jsonl`),
      `${userLine(archivedId, "/work/app", "One more thing", later, `${archivedId.slice(0, -2)}bb`)}\n`,
    );
    expect(await listed(claude)).toEqual([archivedId, keptId]);
  });

  test("unarchiving a session that was never archived writes nothing and does not throw", async () => {
    await client().unarchiveNativeSession(handle(keptId));
    expect(fs.existsSync(mark(project, keptId))).toBe(false);
    await client().unarchiveNativeSession(handle("1b6a1c55-3f3e-4a43-9a7f-0f3f5d1b2c09"));
  });

  test("a provider pointed at another Claude config dir gets no mark", async () => {
    const daemonHome = fs.mkdtempSync(path.join(tmp, "daemon-home-"));
    process.env.CLAUDE_CONFIG_DIR = daemonHome;
    const claude = client({ CLAUDE_CONFIG_DIR: configDir });

    await claude.archiveNativeSession(handle(archivedId));
    expect(fs.existsSync(mark(project, archivedId))).toBe(false);
    expect(fs.readdirSync(daemonHome)).toEqual([]);
    expect(await listed(claude)).toEqual([archivedId, keptId]);
  });

  test("archived sessions do not use up the scan", async () => {
    const claude = client();
    const newer = new Date(Date.now() + 500);
    fs.utimesSync(path.join(project, `${archivedId}.jsonl`), newer, newer);
    await claude.archiveNativeSession(handle(archivedId));

    const sessions = await claude.listImportableSessions({ limit: 1, scanLimit: 1 });
    expect(sessions.map((session) => session.providerHandleId)).toEqual([keptId]);
  });

  test("each copy of a session in another project answers for itself", async () => {
    const oldProject = path.join(configDir, "projects", "-work-old");
    fs.mkdirSync(oldProject, { recursive: true });
    writeTranscript(oldProject, archivedId, "/work/old", "Archive me");
    const claude = client();

    await claude.archiveNativeSession(handle(archivedId));
    expect(readMark(oldProject, archivedId).archived).toBe(true);
    expect(await listed(claude, { cwd: "/work/old" })).toEqual([]);

    const later = new Date(Date.now() + 60_000).toISOString();
    fs.appendFileSync(
      path.join(oldProject, `${archivedId}.jsonl`),
      `${userLine(archivedId, "/work/old", "Back to it", later, `${archivedId.slice(0, -2)}dd`)}\n`,
    );
    expect(await listed(claude, { cwd: "/work/old" })).toEqual([archivedId]);
    expect(await listed(claude, { cwd: "/work/app" })).toEqual([keptId]);
  });
  test("a copy whose folder no longer matches its cwd is judged by its own transcript", async () => {
    // The project moved: this copy's cwd no longer leads to its folder, so the SDK looks it up by id
    // and may read either copy. It is hidden only when the SDK read it, so a copy in use stays listed.
    const moved = path.join(configDir, "projects", "-work-moved");
    fs.mkdirSync(moved, { recursive: true });
    writeTranscript(moved, archivedId, "/work/old", "Archive me");
    const claude = client();

    await claude.archiveNativeSession(handle(archivedId));
    expect(await listed(claude, { cwd: "/work/app" })).toEqual([keptId]);

    const later = new Date(Date.now() + 60_000).toISOString();
    fs.appendFileSync(
      path.join(moved, `${archivedId}.jsonl`),
      `${userLine(archivedId, "/work/old", "Back to it", later, `${archivedId.slice(0, -2)}ff`)}\n`,
    );
    expect(await listed(claude)).toEqual([archivedId, keptId]);
  });

  test("a copy of the same size is not taken for this one", async () => {
    // Same bytes as the -work-app copy, an older mtime; its cwd leads to the other folder.
    const moved = path.join(configDir, "projects", "-work-moved");
    fs.mkdirSync(moved, { recursive: true });
    fs.copyFileSync(
      path.join(project, `${archivedId}.jsonl`),
      path.join(moved, `${archivedId}.jsonl`),
    );
    const older = new Date("2026-02-01T00:00:00.000Z");
    fs.utimesSync(path.join(moved, `${archivedId}.jsonl`), older, older);
    const claude = client();
    await claude.archiveNativeSession(handle(archivedId));
    // Another SDK client unarchived only the moved copy (unarchiveSession with its project).
    fs.writeFileSync(
      mark(moved, archivedId),
      JSON.stringify({ archived: false, at: new Date().toISOString(), by: "sdk" }),
    );

    expect(await listed(claude)).toEqual([archivedId, keptId]);
  });

  test("unarchiving clears every copy's mark, even when a prompt already unarchived one", async () => {
    const oldProject = path.join(configDir, "projects", "-work-old");
    fs.mkdirSync(oldProject, { recursive: true });
    fs.copyFileSync(
      path.join(project, `${archivedId}.jsonl`),
      path.join(oldProject, `${archivedId}.jsonl`),
    );
    const claude = client();
    await claude.archiveNativeSession(handle(archivedId));
    const later = new Date(Date.now() + 60_000).toISOString();
    fs.appendFileSync(
      path.join(project, `${archivedId}.jsonl`),
      `${userLine(archivedId, "/work/app", "Back to it", later, `${archivedId.slice(0, -2)}bb`)}\n`,
    );

    await claude.unarchiveNativeSession(handle(archivedId));
    expect(readMark(project, archivedId).archived).toBe(false);
    expect(readMark(oldProject, archivedId).archived).toBe(false);
  });
  test("a session used again after the archive stays listed when a long reply hides the prompt", async () => {
    // The SDK looks for a later prompt only in the first and last 64 KiB of the transcript.
    const transcript = path.join(project, `${archivedId}.jsonl`);
    const reply = (uuid: string, timestamp: string) =>
      JSON.stringify({
        type: "assistant",
        uuid,
        parentUuid: null,
        sessionId: archivedId,
        cwd: "/work/app",
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200_000) }] },
      });
    fs.appendFileSync(
      transcript,
      `${reply(`${archivedId.slice(0, -2)}a1`, "2026-01-01T00:00:01.000Z")}\n`,
    );
    const claude = client();
    await claude.archiveNativeSession(handle(archivedId));
    expect(await listed(claude)).toEqual([keptId]);

    const later = new Date(Date.now() + 60_000).toISOString();
    fs.appendFileSync(
      transcript,
      `${userLine(archivedId, "/work/app", "One more thing", later, `${archivedId.slice(0, -2)}bb`)}\n`,
    );
    fs.appendFileSync(transcript, `${reply(`${archivedId.slice(0, -2)}cc`, later)}\n`);
    const written = new Date(Date.now() + 5000);
    fs.utimesSync(transcript, written, written);
    expect(await listed(claude)).toEqual([archivedId, keptId]);
  });
});
