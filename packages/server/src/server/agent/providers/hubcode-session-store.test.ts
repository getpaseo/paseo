import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHubcodeSession, saveHubcodeSession } from "./hubcode-session-store";

describe("hubcode session store", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(tmpdir(), "hubcode-session-test-"));
    process.env.HUBCODE_HOME = tmp;
  });

  afterEach(async () => {
    delete process.env.HUBCODE_HOME;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns null for a missing session", async () => {
    expect(await loadHubcodeSession("never-existed")).toBeNull();
  });

  it("round-trips messages, mode, and model", async () => {
    const messages = [
      { role: "user", content: "oi" },
      { role: "assistant", content: "olá!" },
    ];
    await saveHubcodeSession({
      sessionId: "abc-123",
      modeId: "plan",
      model: "test-combo",
      messages,
    });
    const loaded = await loadHubcodeSession("abc-123");
    expect(loaded).not.toBeNull();
    expect(loaded?.modeId).toBe("plan");
    expect(loaded?.model).toBe("test-combo");
    expect(loaded?.messages).toEqual(messages);
    expect(loaded?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("overwrites an existing session atomically", async () => {
    await saveHubcodeSession({
      sessionId: "x",
      modeId: "default",
      messages: [{ role: "user", content: "first" }],
    });
    await saveHubcodeSession({
      sessionId: "x",
      modeId: "acceptEdits",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
      ],
    });
    const loaded = await loadHubcodeSession("x");
    expect(loaded?.modeId).toBe("acceptEdits");
    expect(loaded?.messages).toHaveLength(2);
  });

  it("ignores records written by an incompatible schema", async () => {
    // Hand-write a record with a future schema version we don't understand.
    const dir = path.join(tmp, "hubcode-sessions");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, encodeURIComponent("future") + ".json"),
      JSON.stringify({ schemaVersion: 999, sessionId: "future", messages: [] }),
    );
    expect(await loadHubcodeSession("future")).toBeNull();
  });
});
