import { runGitCommand } from "../../utils/run-git-command.js";

/**
 * Whether a worktree can be linked by relative path, which is what makes it
 * usable from inside a container.
 *
 * A worktree's `.git` file and its admin directory's `gitdir` file normally
 * hold absolute host paths, so inside a container the link dangles and the
 * agent's own git answers `fatal: not a git repository`. Created with
 * `--relative-paths` they hold relative ones instead, and
 * `devcontainer up --mount-git-worktree-common-dir` mounts the git directory
 * where those resolve.
 *
 * The catch is that relative links are a property of the *repository*: git
 * 2.48 added them, and enabling them writes `extensions.relativeWorktrees`,
 * which older git refuses to open at all —
 * `fatal: unknown repository extensions found: relativeworktrees`. So both
 * sides have to be able to read the result: the host, whose git is Paseo's and
 * the user's, and the image, whose git is the agent's. Either one being older
 * means the worktree is created the ordinary way instead.
 */

/** Relative worktree links, and the extension they set, arrived in git 2.48. */
const MIN_MAJOR = 2;
const MIN_MINOR = 48;
const GIT_VERSION_TIMEOUT_MS = 10_000;

let hostSupport: Promise<boolean> | null = null;

/** `git version 2.48.1` → `{ major: 2, minor: 48 }`. */
export function parseGitVersion(output: string): { major: number; minor: number } | null {
  const match = /git version (\d+)\.(\d+)/u.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function versionSupportsRelativeWorktrees(output: string): boolean {
  const version = parseGitVersion(output);
  if (!version) return false;
  return version.major > MIN_MAJOR || (version.major === MIN_MAJOR && version.minor >= MIN_MINOR);
}

/** The daemon's own git. Cached — it does not change while we run. */
export async function hostGitSupportsRelativeWorktrees(): Promise<boolean> {
  hostSupport ??= runGitCommand(["--version"], {
    cwd: process.cwd(),
    timeout: GIT_VERSION_TIMEOUT_MS,
  })
    .then((result) => versionSupportsRelativeWorktrees(result.stdout))
    .catch(() => false);
  return hostSupport;
}
