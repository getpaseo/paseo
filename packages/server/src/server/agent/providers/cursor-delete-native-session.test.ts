import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteCursorNativeSession } from "./cursor-delete-native-session.js";

describe("deleteCursorNativeSession", () => {
  it("removes the ACP session directory", async () => {
    const cursorHome = await mkdtemp(join(tmpdir(), "paseo-cursor-delete-"));
    const sessionId = "60ed4529-6140-45ec-a540-6ba2b3d193a7";
    const sessionDir = join(cursorHome, "acp-sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "meta.json"), "{}", "utf8");

    await deleteCursorNativeSession({ sessionId, cursorHome });

    await expect(access(sessionDir)).rejects.toThrow();
    await rm(cursorHome, { recursive: true, force: true });
  });

  it("no-ops for invalid session ids", async () => {
    const cursorHome = await mkdtemp(join(tmpdir(), "paseo-cursor-delete-"));
    await deleteCursorNativeSession({
      sessionId: "../etc/passwd",
      cursorHome,
    });
    await rm(cursorHome, { recursive: true, force: true });
  });
});
