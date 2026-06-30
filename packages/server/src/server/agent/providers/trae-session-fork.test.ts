import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkTraeSessionFiles, resolveTraeSessionsDir } from "./trae-session-fork";

describe("resolveTraeSessionsDir", () => {
  const original = process.env.TRAE_SESSIONS_DIR;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.TRAE_SESSIONS_DIR;
    } else {
      process.env.TRAE_SESSIONS_DIR = original;
    }
  });

  it("defaults to ~/Library/Caches/trae-cli/sessions and honors the override", () => {
    delete process.env.TRAE_SESSIONS_DIR;
    expect(
      resolveTraeSessionsDir().endsWith(path.join("Library", "Caches", "trae-cli", "sessions")),
    ).toBe(true);
    process.env.TRAE_SESSIONS_DIR = "/tmp/custom-trae";
    expect(resolveTraeSessionsDir()).toBe("/tmp/custom-trae");
  });
});

describe("forkTraeSessionFiles", () => {
  let dir: string;
  const sourceId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "trae-fork-test-"));

    // Create source session directory
    const sourceDir = path.join(dir, sourceId);
    mkdirSync(sourceDir);

    // session.json — mirrors real Trae CLI format
    writeFileSync(
      path.join(sourceDir, "session.json"),
      JSON.stringify({
        id: sourceId,
        created_at: "2026-06-30T18:59:08.425048+08:00",
        updated_at: "2026-06-30T18:59:08.425048+08:00",
        metadata: {
          cwd: "/work",
          model_name: "GLM-5.2",
          permission_mode: "bypass_permissions",
          title: "Original Session",
        },
      }),
      "utf8",
    );

    // events.jsonl — each line has session_id
    writeFileSync(
      path.join(sourceDir, "events.jsonl"),
      [
        JSON.stringify({
          id: "evt-1",
          session_id: sourceId,
          branch: "Trae CLI",
          agent_name: "Trae CLI",
        }),
        JSON.stringify({
          id: "evt-2",
          session_id: sourceId,
          branch: "Trae CLI",
          agent_name: "Trae CLI",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    // traces.jsonl — telemetry.session.id in tag values
    writeFileSync(
      path.join(sourceDir, "traces.jsonl"),
      JSON.stringify({
        traceID: "abc123",
        spanID: "span1",
        logs: [
          {
            timestamp: 1234567890,
            fields: [
              { key: "telemetry.session.id", type: "string", value: sourceId },
              { key: "telemetry.event.name", type: "string", value: "tool_request" },
            ],
          },
        ],
      }) + "\n",
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("duplicates session directory into a new id, rewriting internal references", () => {
    const newId = forkTraeSessionFiles({ sessionsDir: dir, sourceId, titleSuffix: " (fork)" });

    expect(newId).not.toBe(sourceId);

    // New directory exists
    const destDir = path.join(dir, newId);
    expect(existsSync(destDir)).toBe(true);

    // session.json: id rewritten, title annotated
    const forked = JSON.parse(readFileSync(path.join(destDir, "session.json"), "utf8"));
    expect(forked.id).toBe(newId);
    expect(forked.metadata.title).toBe("Original Session (fork)");
    expect(forked.metadata.cwd).toBe("/work");

    // events.jsonl: session_id rewritten in every line
    const events = readFileSync(path.join(destDir, "events.jsonl"), "utf8");
    expect(events).not.toContain(sourceId);
    expect(events).toContain(`"session_id":"${newId}"`);

    // traces.jsonl: telemetry.session.id rewritten
    const traces = readFileSync(path.join(destDir, "traces.jsonl"), "utf8");
    expect(traces).not.toContain(sourceId);
    expect(traces).toContain(newId);

    // Source directory is untouched
    const source = JSON.parse(readFileSync(path.join(dir, sourceId, "session.json"), "utf8"));
    expect(source.id).toBe(sourceId);
    expect(source.metadata.title).toBe("Original Session");
  });

  it("uses the provided new id when given", () => {
    const newId = "22222222-2222-4222-8222-222222222222";
    expect(forkTraeSessionFiles({ sessionsDir: dir, sourceId, newId })).toBe(newId);
    expect(existsSync(path.join(dir, newId))).toBe(true);
    expect(existsSync(path.join(dir, newId, "session.json"))).toBe(true);
  });

  it("throws when the source session directory is missing", () => {
    expect(() => forkTraeSessionFiles({ sessionsDir: dir, sourceId: "does-not-exist" })).toThrow(
      /not found/,
    );
  });

  it("works without optional files (traces.jsonl missing)", () => {
    // Remove traces.jsonl from source
    const sourceDir = path.join(dir, sourceId);
    rmSync(path.join(sourceDir, "traces.jsonl"));

    const newId = forkTraeSessionFiles({ sessionsDir: dir, sourceId });
    const destDir = path.join(dir, newId);
    expect(existsSync(path.join(destDir, "session.json"))).toBe(true);
    expect(existsSync(path.join(destDir, "events.jsonl"))).toBe(true);
    expect(existsSync(path.join(destDir, "traces.jsonl"))).toBe(false);
  });
});
