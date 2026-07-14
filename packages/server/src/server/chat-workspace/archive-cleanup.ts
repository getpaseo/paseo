import { realpath, rm } from "node:fs/promises";
import path from "node:path";

import type pino from "pino";
import { isChatScratchDir, pathsReferToSameDirectory, resolveChatsRoot } from "./scratch-dir.js";

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Chat scratch dirs are daemon-owned, not user projects — archiving a chat workspace
// should reclaim the disk space. Deletion is best-effort: a locked file on Windows
// logs a warning and leaves the directory behind rather than failing the archive.
export async function deleteChatWorkspaceScratchDir(input: {
  paseoHome: string;
  cwd: string;
  sessionLogger: pino.Logger;
}): Promise<void> {
  const { paseoHome, cwd, sessionLogger } = input;
  if (!isChatScratchDir(paseoHome, cwd)) {
    return;
  }

  try {
    // realpath resolves junctions and symlinks: if the recorded path or the scratch
    // dir itself reparses to somewhere outside the chats root, refuse to delete —
    // a recursive rm here must never be able to reach a real project directory.
    const chatsRootReal = await realpath(resolveChatsRoot(paseoHome));
    const cwdReal = await realpath(cwd);
    if (!pathsReferToSameDirectory(chatsRootReal, path.dirname(cwdReal))) {
      sessionLogger.warn(
        { cwd, cwdReal },
        "Refusing to delete chat scratch dir that resolves outside the chats root",
      );
      return;
    }
    await rm(cwdReal, { recursive: true, force: true });
  } catch (err) {
    if (isMissingPathError(err)) {
      return;
    }
    sessionLogger.warn({ err, cwd }, "Failed to delete chat workspace scratch dir");
  }
}
