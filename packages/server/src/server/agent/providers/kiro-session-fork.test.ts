import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forkKiroSessionFiles, resolveKiroSessionsDir } from "./kiro-session-fork";

describe("resolveKiroSessionsDir", () => {
  const original = process.env.KIRO_SESSIONS_DIR;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.KIRO_SESSIONS_DIR;
    } else {
      process.env.KIRO_SESSIONS_DIR = original;
    }
  });

  it("defaults to ~/.kiro/sessions/cli and honors the override", () => {
    delete process.env.KIRO_SESSIONS_DIR;
    expect(resolveKiroSessionsDir().endsWith(path.join(".kiro", "sessions", "cli"))).toBe(true);
    process.env.KIRO_SESSIONS_DIR = "/tmp/custom-kiro";
    expect(resolveKiroSessionsDir()).toBe("/tmp/custom-kiro");
  });
});

describe("forkKiroSessionFiles", () => {
  let dir: string;
  const sourceId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "kiro-fork-test-"));
    writeFileSync(
      path.join(dir, `${sourceId}.json`),
      JSON.stringify({
        session_id: sourceId,
        cwd: "/work",
        title: "Original",
        session_state: { version: 1, conversation_metadata: { messages: ["m1", "m2"] } },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(dir, `${sourceId}.jsonl`),
      `{"kind":"Prompt","data":{"message_id":"m1"}}\n{"kind":"AssistantMessage","data":{"message_id":"a1"}}\n`,
      "utf8",
    );
    writeFileSync(path.join(dir, `${sourceId}.history`), "hi\n", "utf8");
    mkdirSync(path.join(dir, sourceId));
    writeFileSync(path.join(dir, sourceId, "extra.bin"), "x", "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("duplicates all session files into a new id, rewriting session_id", async () => {
    const newId = await forkKiroSessionFiles({
      sessionsDir: dir,
      sourceId,
      titleSuffix: " (fork)",
    });

    expect(newId).not.toBe(sourceId);

    const forked = JSON.parse(readFileSync(path.join(dir, `${newId}.json`), "utf8"));
    // New id, full context preserved (session_state copied verbatim), title annotated.
    expect(forked.session_id).toBe(newId);
    expect(forked.title).toBe("Original (fork)");
    expect(forked.session_state).toEqual({
      version: 1,
      conversation_metadata: { messages: ["m1", "m2"] },
    });

    // Event log + history + sidecar dir copied.
    expect(readFileSync(path.join(dir, `${newId}.jsonl`), "utf8")).toBe(
      readFileSync(path.join(dir, `${sourceId}.jsonl`), "utf8"),
    );
    expect(readFileSync(path.join(dir, `${newId}.history`), "utf8")).toBe("hi\n");
    expect(existsSync(path.join(dir, newId, "extra.bin"))).toBe(true);

    // Source is untouched.
    const source = JSON.parse(readFileSync(path.join(dir, `${sourceId}.json`), "utf8"));
    expect(source.session_id).toBe(sourceId);
    expect(source.title).toBe("Original");
  });

  it("uses the provided new id when given", async () => {
    const newId = "22222222-2222-4222-8222-222222222222";
    expect(await forkKiroSessionFiles({ sessionsDir: dir, sourceId, newId })).toBe(newId);
    expect(existsSync(path.join(dir, `${newId}.json`))).toBe(true);
  });

  it("throws when the source session metadata is missing", async () => {
    await expect(
      forkKiroSessionFiles({ sessionsDir: dir, sourceId: "does-not-exist" }),
    ).rejects.toThrow(/not found/);
  });
});
