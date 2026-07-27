import { promises as fs } from "node:fs";
import { join } from "node:path";

const GROK_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete Grok's on-disk ACP session directory:
 * `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/`
 */
export async function deleteGrokNativeSession(input: {
  grokHome: string;
  cwd: string | undefined;
  sessionId: string | undefined;
}): Promise<void> {
  if (!input.cwd || !input.sessionId || !GROK_SESSION_ID_PATTERN.test(input.sessionId)) {
    return;
  }
  await fs.rm(join(input.grokHome, "sessions", encodeURIComponent(input.cwd), input.sessionId), {
    recursive: true,
    force: true,
  });
}
