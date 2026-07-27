import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteGrokNativeSession } from "./grok-delete-native-session.js";

describe("deleteGrokNativeSession", () => {
  it("removes the session directory under the encoded cwd", async () => {
    const grokHome = await mkdtemp(join(tmpdir(), "paseo-grok-delete-"));
    const cwd = "/Users/me/Code/paseo";
    const sessionId = "019f9302-58fc-7891-a480-6a6e4ddb90ff";
    const sessionDir = join(grokHome, "sessions", encodeURIComponent(cwd), sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "chat_history.jsonl"), "{}\n", "utf8");

    await deleteGrokNativeSession({ grokHome, cwd, sessionId });

    await expect(access(sessionDir)).rejects.toThrow();
    await rm(grokHome, { recursive: true, force: true });
  });

  it("no-ops for invalid session ids", async () => {
    const grokHome = await mkdtemp(join(tmpdir(), "paseo-grok-delete-"));
    await deleteGrokNativeSession({
      grokHome,
      cwd: "/tmp",
      sessionId: "../etc/passwd",
    });
    await rm(grokHome, { recursive: true, force: true });
  });
});
