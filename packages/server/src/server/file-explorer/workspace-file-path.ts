import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export async function resolveWorkspaceDocumentPath(cwd: string, requested: string) {
  const root = await realpath(cwd);
  const full = await realpath(path.resolve(root, requested));
  if (full !== root && !full.startsWith(root + path.sep))
    throw new Error("Documents must be inside this workspace");
  if (!(await stat(full)).isFile()) throw new Error("Choose a regular file");
  return full;
}
