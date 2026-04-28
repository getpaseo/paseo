import { promises as fs } from "node:fs";
import path from "node:path";

const CRG_INDEX_DIR = ".code-review-graph";

/**
 * Best-effort computation of the on-disk size of a workspace's crg index
 * directory (`<cwd>/.code-review-graph/`). Returns undefined when the dir
 * doesn't exist (crg hasn't indexed yet) or any traversal error happens —
 * the caller should treat undefined as "unknown" rather than "zero", since
 * we don't want the UI to flip from a known size to 0 during a transient
 * fs glitch.
 */
export async function computeCrgIndexBytes(cwd: string): Promise<number | undefined> {
  const root = path.join(cwd, CRG_INDEX_DIR);
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  try {
    return await sumDir(root);
  } catch {
    return undefined;
  }
}

async function sumDir(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sumDir(full);
    } else if (entry.isFile()) {
      try {
        const s = await fs.stat(full);
        total += s.size;
      } catch {
        // Ignore files that disappeared mid-walk (e.g. crg is writing).
      }
    }
  }
  return total;
}
