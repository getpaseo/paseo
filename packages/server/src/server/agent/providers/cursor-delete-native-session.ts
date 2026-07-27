import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CURSOR_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete Cursor ACP's on-disk session directory:
 * `~/.cursor/acp-sessions/<sessionId>/`
 */
export async function deleteCursorNativeSession(input: {
  sessionId: string | undefined;
  cursorHome?: string;
}): Promise<void> {
  if (!input.sessionId || !CURSOR_SESSION_ID_PATTERN.test(input.sessionId)) {
    return;
  }
  const cursorHome = input.cursorHome ?? join(homedir(), ".cursor");
  await fs.rm(join(cursorHome, "acp-sessions", input.sessionId), {
    recursive: true,
    force: true,
  });
}
