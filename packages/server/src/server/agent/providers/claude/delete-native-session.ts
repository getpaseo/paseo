import { promises as fs } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "./project-dir.js";

/**
 * Permanently delete a Claude native session's JSONL file and any sidecar
 * directory from the provider's project directory. Best-effort: missing files
 * are silently ignored.
 */
export async function deleteClaudeNativeSession(
  cwd: string | undefined,
  sessionId: string | undefined,
  configDir?: string,
): Promise<void> {
  if (!cwd || !sessionId) return;
  const projectDir = await claudeProjectDir(cwd, configDir ? { configDir } : undefined);
  await fs.rm(join(projectDir, `${sessionId}.jsonl`), { force: true });
  await fs.rm(join(projectDir, sessionId), { recursive: true, force: true });
}
