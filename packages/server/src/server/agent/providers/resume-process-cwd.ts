import { stat } from "node:fs/promises";
import { homedir } from "node:os";

import type { AgentResumePurpose } from "../agent-sdk-types.js";

export async function resolveResumeProcessCwd(
  cwd: string,
  purpose: AgentResumePurpose | undefined,
): Promise<string> {
  if (purpose !== "history" || (await isDirectory(cwd))) {
    return cwd;
  }
  return homedir();
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}
