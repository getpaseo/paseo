import { runGitCommand, type RunGitCommand } from "../../../utils/run-git-command.js";

// Names and subjects only. A new chat has no conversation to guess from, so the
// repository is the only signal — but no file's contents may leave the machine.
export interface NewChatWorkspaceContext {
  branch: string | null;
  changedPaths: string[];
  recentCommits: string[];
  moreChangedPaths: number;
}

export type WorkspaceContextReader = (cwd: string) => Promise<NewChatWorkspaceContext | null>;

const MAX_CHANGED_PATHS = 25;
const MAX_COMMITS = 8;
const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } as const;

export function createWorkspaceContextReader(options?: {
  runGit?: RunGitCommand;
}): WorkspaceContextReader {
  const runGit = options?.runGit ?? runGitCommand;

  return async (cwd: string): Promise<NewChatWorkspaceContext | null> => {
    if (!cwd.trim()) {
      return null;
    }
    const read = async (args: string[]): Promise<string | null> => {
      try {
        const { stdout, exitCode } = await runGit(args, {
          cwd,
          envOverlay: READ_ONLY_GIT_ENV,
          acceptExitCodes: [0, 1, 128],
        });
        return exitCode === 0 ? stdout : null;
      } catch {
        return null;
      }
    };

    // Outside a repository there is nothing to describe, and inventing work for
    // an empty directory is worse than staying quiet.
    const inside = await read(["rev-parse", "--is-inside-work-tree"]);
    if (inside?.trim() !== "true") {
      return null;
    }

    const [branchOut, statusOut, logOut] = await Promise.all([
      read(["rev-parse", "--abbrev-ref", "HEAD"]),
      read(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      read(["log", `--max-count=${MAX_COMMITS}`, "--format=%s"]),
    ]);

    const branch = normalizeBranch(branchOut);
    const changed = parsePorcelainPaths(statusOut ?? "");
    const recentCommits = (logOut ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_COMMITS);

    if (!branch && changed.length === 0 && recentCommits.length === 0) {
      return null;
    }
    return {
      branch,
      changedPaths: changed.slice(0, MAX_CHANGED_PATHS),
      recentCommits,
      moreChangedPaths: Math.max(0, changed.length - MAX_CHANGED_PATHS),
    };
  };
}

function normalizeBranch(value: string | null): string | null {
  const branch = value?.trim();
  if (!branch || branch === "HEAD") {
    return null;
  }
  return branch;
}

// `-z` keeps paths verbatim: no C-quoting, so a filename with a space or a
// newline survives. A rename record is followed by its source path.
function parsePorcelainPaths(stdout: string): string[] {
  const records = stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.startsWith("R") || status.startsWith("C")) {
      index += 1;
    }
  }
  return paths;
}
