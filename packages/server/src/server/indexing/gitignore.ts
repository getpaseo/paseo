import { promises as fs } from "node:fs";
import path from "node:path";

const CRG_DIR = ".code-review-graph/";
const SECTION_HEADER = "# Hubcode code-review-graph index";

/**
 * Idempotently ensure `.code-review-graph/` is ignored by the repo's
 * `.gitignore`. Creates the file if missing, appends a labeled section if it
 * does not contain the rule yet, and is a no-op otherwise.
 *
 * Returns whether the file was modified so callers can show a confirmation
 * toast on first enable.
 */
export interface EnsureGitignoreOptions {
  readFile?: (file: string) => Promise<string>;
  writeFile?: (file: string, content: string) => Promise<void>;
  rule?: string;
  header?: string;
}

export async function ensureCrgGitignore(
  repoRoot: string,
  options: EnsureGitignoreOptions = {},
): Promise<{ modified: boolean; created: boolean; gitignorePath: string }> {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const rule = options.rule ?? CRG_DIR;
  const header = options.header ?? SECTION_HEADER;
  const read = options.readFile ?? defaultRead;
  const write = options.writeFile ?? defaultWrite;

  const existing = await read(gitignorePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

  if (existing === null) {
    const content = `${header}\n${rule}\n`;
    await write(gitignorePath, content);
    return { modified: true, created: true, gitignorePath };
  }

  if (containsRule(existing, rule)) {
    return { modified: false, created: false, gitignorePath };
  }

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const trailing = existing.length === 0 ? "" : "\n";
  const next = `${existing}${separator}${trailing}${header}\n${rule}\n`;
  await write(gitignorePath, next);
  return { modified: true, created: false, gitignorePath };
}

export function containsRule(gitignoreContent: string, rule: string): boolean {
  const normalizedRule = rule.replace(/\/+$/, "");
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.replace(/^!/, "").replace(/\/+$/, "");
    if (normalized === normalizedRule) return true;
    // A bare "code-review-graph" or trailing-slash variant should also count.
    if (normalized === rule.replace(/\/+$/, "")) return true;
  }
  return false;
}

async function defaultRead(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

async function defaultWrite(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, "utf8");
}
