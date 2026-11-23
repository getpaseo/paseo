import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const GITFILE_PREFIX = "gitdir:";

/**
 * True when `cwd` is a bare repository that a linked worktree checkout points
 * back to: some `<cwd>/worktrees/<name>/gitdir` names a real `.git` file whose
 * `gitdir:` line resolves to that same `worktrees/<name>` directory. A clone
 * cannot contain `.git` files, so a directory layout that only looks like a bare
 * repository never passes. Symlinked entries and unreadable files count as not
 * linked.
 */
export async function isLinkedBareRepository(cwd: string): Promise<boolean> {
  try {
    if (!(await lstat(join(cwd, "HEAD"))).isFile()) return false;
    const worktreesDir = join(await realpath(cwd), "worktrees");
    if (!(await lstat(worktreesDir)).isDirectory()) return false;
    const entries = await readdir(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (await isLinkedWorktreeAdminDir(worktreesDir, entry)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function isLinkedWorktreeAdminDir(worktreesDir: string, entry: Dirent): Promise<boolean> {
  if (!entry.isDirectory()) return false;
  const adminDir = join(worktreesDir, entry.name);
  try {
    const gitdirFile = join(adminDir, "gitdir");
    if (!(await lstat(gitdirFile)).isFile()) return false;
    const dotGitPath = resolve(adminDir, (await readFile(gitdirFile, "utf8")).trim());
    if (basename(dotGitPath) !== ".git") return false;
    if (!(await lstat(dotGitPath)).isFile()) return false;
    const firstLine = (await readFile(dotGitPath, "utf8")).split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith(GITFILE_PREFIX)) return false;
    const target = resolve(dirname(dotGitPath), firstLine.slice(GITFILE_PREFIX.length).trim());
    return (await realpath(target)) === adminDir;
  } catch {
    return false;
  }
}
