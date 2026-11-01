import type { ChangedFile } from "@getpaseo/protocol/goal/types";
import { runGitCommand } from "../../utils/run-git-command.js";
import { spawnProcess } from "../../utils/spawn.js";

export interface CapturedChange {
  branch: string;
  baseCommit: string;
  headCommit: string;
  files: ChangedFile[];
}

export type MergeOutcome = { ok: true; headCommit: string } | { ok: false; conflicts: string[] };

export interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  /** The last part of combined stdout and stderr. */
  output: string;
}

/** What the change-set pipeline needs from git and the shell. */
export interface GitPort {
  /**
   * Commit anything uncommitted, then describe the work against the integration
   * commit. Null when there is none. Commits, not branch names, are used because
   * Paseo may rename a worktree's branch after creation.
   */
  capture(input: {
    cwd: string;
    integrationCommit: string;
    message: string;
  }): Promise<CapturedChange | null>;
  /** True when the worktree has no uncommitted or untracked changes. */
  isClean(cwd: string): Promise<boolean>;
  /** `git status --porcelain` lines of tracked files with uncommitted changes; empty when none. */
  trackedChanges(cwd: string): Promise<string>;
  head(cwd: string): Promise<string>;
  /**
   * The full id of the commit `id` names in the repository at cwd, or null. Only a commit id
   * of at least 7 hex digits counts: a branch or tag name, an ambiguous prefix, an option, or
   * an object that is not a commit gives null, even when the name looks like hex.
   */
  resolveCommit(cwd: string, id: string): Promise<string | null>;
  currentBranch(cwd: string): Promise<string>;
  /**
   * Merge a commit into the branch checked out at cwd. A conflict is aborted and reported.
   * Refuses when a tracked file has uncommitted changes. Untracked files do not block it:
   * git itself refuses a merge that would overwrite one, and that failure is thrown.
   */
  merge(input: { cwd: string; commit: string; message: string }): Promise<MergeOutcome>;
  /** Discard a half-finished merge and move the checked-out branch back to a commit. */
  resetHard(input: { cwd: string; commit: string }): Promise<void>;
  /** `key` groups commands (by goal) so they can be stopped together. */
  runCommand(input: {
    cwd: string;
    command: string;
    timeoutMs: number;
    key?: string;
  }): Promise<CommandOutcome>;
  /** Kill running commands for a key, or all of them. Their results report a signal exit. */
  killCommands(key?: string): void;
  /**
   * What a worktree holds compared with `baseCommit`, for the Lead to read: the diff stat, the
   * status of tracked files and a count of untracked ones, capped at 4000 characters. Never
   * takes git's index lock, so it is safe while an agent still works there. Never throws: a
   * failure or the time limit gives a line saying the summary is unavailable.
   */
  workSummary(input: { cwd: string; baseCommit?: string; timeoutMs?: number }): Promise<string>;
}

const OUTPUT_TAIL_CHARS = 4000;
const WORK_SUMMARY_CHARS = 4000;
const WORK_SUMMARY_TIMEOUT_MS = 10_000;
/** Untracked files counted at most; a tree with more says "at least". */
const UNTRACKED_COUNT_CAP = 10_000;
const WORK_SUMMARY_ERROR_CHARS = 300;

/** The work summary of a worktree; see GitPort.workSummary. */
async function readWorkSummary(input: {
  cwd: string;
  baseCommit?: string;
  timeoutMs?: number;
}): Promise<string> {
  // One deadline for all three commands, so the summary never takes longer than asked.
  const deadline = Date.now() + (input.timeoutMs ?? WORK_SUMMARY_TIMEOUT_MS);
  const run = (args: string[], maxOutputBytes = WORK_SUMMARY_CHARS * 2) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error("timed out");
    return runGitCommand(["--no-optional-locks", ...args], {
      cwd: input.cwd,
      timeout,
      maxOutputBytes,
    });
  };
  const base = input.baseCommit ?? "HEAD";
  try {
    const stat = await run(["diff", "--stat", base, "--"]);
    const status = await run(["status", "--short", "-uno"]);
    // Each path is at most a few hundred bytes; the cap stops reading a huge tree early.
    const untracked = await run(
      ["ls-files", "--others", "--exclude-standard"],
      UNTRACKED_COUNT_CAP * 64,
    );
    const lines = untracked.stdout.split("\n").filter((line) => line.length > 0).length;
    const count = Math.min(lines, UNTRACKED_COUNT_CAP);
    const untrackedLine =
      untracked.truncated || lines > UNTRACKED_COUNT_CAP
        ? `Untracked files: at least ${count}`
        : `Untracked files: ${count}`;
    const text = [
      `Changes since ${base}:`,
      stat.stdout.trim() || "(none)",
      "",
      "Uncommitted changes to tracked files:",
      status.stdout.trim() || "(none)",
      "",
      untrackedLine,
    ].join("\n");
    return text.length <= WORK_SUMMARY_CHARS
      ? text
      : `${text.slice(0, WORK_SUMMARY_CHARS - 12)}\n[truncated]`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const shown = /timed out/.test(reason)
      ? "timed out"
      : reason.slice(0, WORK_SUMMARY_ERROR_CHARS);
    return `(work summary unavailable: ${shown})`;
  }
}

// Commits the Manager makes itself carry an explicit author instead of relying on
// whatever identity the machine has configured.
const COMMIT_IDENTITY = [
  "-c",
  "user.name=Paseo Goal Manager",
  "-c",
  "user.email=goal-manager@paseo.local",
  "-c",
  "commit.gpgsign=false",
];

/** A full or abbreviated SHA-1 or SHA-256 commit id, at least as long as git's usual short id. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

async function git(cwd: string, args: string[], accept?: number[]) {
  return runGitCommand(args, { cwd, ...(accept ? { acceptExitCodes: accept } : {}) });
}

async function rev(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", ref])).stdout.trim();
}

function parseNameStatus(stdout: string): ChangedFile[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [status = "?", ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
}

/** End a command's whole process group; fall back to the process itself. */
function killGroup(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

const OUTPUT_DRAIN_MS = 100;

export function createGitPort(): GitPort {
  const running_ = new Map<string, Set<() => void>>();
  return {
    async capture({ cwd, integrationCommit, message }) {
      const dirty = (await git(cwd, ["status", "--porcelain"])).stdout.trim().length > 0;
      if (dirty) {
        await git(cwd, ["add", "-A"]);
        await git(cwd, [...COMMIT_IDENTITY, "commit", "-m", message]);
      }
      const headCommit = await rev(cwd, "HEAD");
      const baseCommit = (await git(cwd, ["merge-base", "HEAD", integrationCommit])).stdout.trim();
      if (headCommit === baseCommit) return null;
      const diff = await git(cwd, ["diff", "--name-status", `${baseCommit}..${headCommit}`]);
      const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      return { branch, baseCommit, headCommit, files: parseNameStatus(diff.stdout) };
    },

    head: (cwd) => rev(cwd, "HEAD"),

    async resolveCommit(cwd, id) {
      if (!COMMIT_ID.test(id)) return null;
      // Git answers 1 or 128 for a name it cannot resolve to one commit.
      const result = await git(
        cwd,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${id}^{commit}`],
        [0, 1, 128],
      );
      const resolved = result.exitCode === 0 ? result.stdout.trim().toLowerCase() : "";
      // A ref whose name looks like hex resolves too; only an id that is a prefix of the commit's
      // own counts, so a moving branch can never stand in for a fixed commit.
      return resolved && resolved.startsWith(id.toLowerCase()) ? resolved : null;
    },

    async isClean(cwd) {
      return (await git(cwd, ["status", "--porcelain"])).stdout.trim().length === 0;
    },

    async trackedChanges(cwd) {
      return (await git(cwd, ["status", "--porcelain", "--untracked-files=no"])).stdout.trimEnd();
    },

    async currentBranch(cwd) {
      return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    },

    async merge({ cwd, commit, message }) {
      // Tools leave untracked files (caches, state directories) in worktrees. They do not
      // affect the merge result, so only changes to tracked files block it.
      const dirty = (
        await git(cwd, ["status", "--porcelain", "--untracked-files=no"])
      ).stdout.trim();
      if (dirty.length > 0) {
        throw new Error(`Integration worktree has uncommitted changes:\n${dirty}`);
      }
      const result = await git(
        cwd,
        [...COMMIT_IDENTITY, "merge", "--no-ff", "-m", message, commit],
        // 2: git refused before merging, e.g. an incoming file would overwrite an untracked one.
        [0, 1, 2],
      );
      if (result.exitCode === 0) return { ok: true, headCommit: await rev(cwd, "HEAD") };
      const unmerged = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
      const conflicts = unmerged.stdout.split("\n").filter((line) => line.trim().length > 0);
      if (conflicts.length === 0) {
        // A failure without conflicts is a real failure, not a conflict.
        await git(cwd, ["merge", "--abort"], [0, 128]);
        throw new Error(`git merge failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      await git(cwd, ["merge", "--abort"]);
      return { ok: false, conflicts };
    },

    async resetHard({ cwd, commit }) {
      await git(cwd, ["merge", "--abort"], [0, 128]);
      await git(cwd, ["reset", "--hard", commit]);
      await git(cwd, ["clean", "-fd"]);
    },

    runCommand({ cwd, command, timeoutMs, key = "" }) {
      return new Promise((resolve, reject) => {
        const child = spawnProcess("sh", ["-c", command], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let timedOut = false;
        let settled = false;
        const collect = (chunk: Buffer | string) => {
          output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS * 2);
        };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        const stop = () => killGroup(child);
        const running = running_.get(key) ?? new Set<() => void>();
        running.add(stop);
        running_.set(key, running);
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        const release = () => {
          clearTimeout(timer);
          running.delete(stop);
        };
        child.on("error", (error) => {
          release();
          reject(error);
        });
        // Judge the command by when its own process ends. Waiting for its output
        // pipes to close would also wait for any background child that inherited them.
        child.on("exit", (exitCode) => {
          if (settled) return;
          settled = true;
          release();
          // Whatever the command left running goes with it.
          stop();
          setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve({ exitCode, timedOut, output: output.slice(-OUTPUT_TAIL_CHARS) });
          }, OUTPUT_DRAIN_MS);
        });
      });
    },

    killCommands(key) {
      for (const [k, stops] of running_) {
        if (key !== undefined && k !== key) continue;
        for (const stop of stops) stop();
      }
    },

    workSummary: readWorkSummary,
  };
}
