import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitCommand } from "../../utils/run-git-command.js";
import { worktreeRoot } from "../diff/git.js";

export interface TurnChanges {
  turnId: string;
  before: string;
  after: string;
}

const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "Paseo",
  GIT_AUTHOR_EMAIL: "snapshots@paseo.invalid",
  GIT_COMMITTER_NAME: "Paseo",
  GIT_COMMITTER_EMAIL: "snapshots@paseo.invalid",
  GIT_OPTIONAL_LOCKS: "0",
};

/** Capture the worktree without touching its real index. Ignored files stay ignored. */
export async function captureTurnWorktree(cwd: string): Promise<string | null> {
  const repo = await runGitCommand(["rev-parse", "--is-inside-work-tree"], {
    cwd,
    acceptExitCodes: [0, 128],
  });
  if (repo.exitCode !== 0 || repo.stdout.trim() !== "true") return null;
  cwd = await worktreeRoot(cwd);

  const directory = await mkdtemp(join(tmpdir(), "paseo-turn-changes-"));
  const index = join(directory, "index");
  const envOverlay = { ...SNAPSHOT_ENV, GIT_INDEX_FILE: index };
  try {
    // Start from the committed tree so tracked files and deletions are represented,
    // then add the current worktree including files absent from the real index.
    const head = await runGitCommand(["rev-parse", "--verify", "HEAD"], {
      cwd,
      acceptExitCodes: [0, 128],
    });
    await runGitCommand(head.exitCode === 0 ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], {
      cwd,
      envOverlay,
    });
    await runGitCommand(["add", "--all"], { cwd, envOverlay, timeout: 120_000 });
    const tree = await runGitCommand(["write-tree"], { cwd, envOverlay });
    const commit = await runGitCommand(["commit-tree", tree.stdout.trim()], {
      cwd,
      envOverlay,
      input: "Paseo turn worktree snapshot\n",
    });
    return commit.stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Keep only the latest completed turn reachable by Git garbage collection. */
function refPrefix(agentId: string) {
  const key = createHash("sha256").update(agentId).digest("hex");
  return `refs/paseo/turn-changes/${key}`;
}

export async function retainPendingTurnStart(cwd: string, agentId: string, before: string) {
  await runGitCommand(["update-ref", `${refPrefix(agentId)}/pending`, before], { cwd });
}

export async function discardPendingTurnStart(cwd: string, agentId: string) {
  await runGitCommand(["update-ref", "-d", `${refPrefix(agentId)}/pending`], {
    cwd,
    acceptExitCodes: [0, 1],
  });
}

export async function retainTurnChanges(cwd: string, agentId: string, changes: TurnChanges) {
  const prefix = refPrefix(agentId);
  await runGitCommand(["update-ref", "--stdin"], {
    cwd,
    input: `start\nupdate ${prefix}/before ${changes.before}\nupdate ${prefix}/after ${changes.after}\ndelete ${prefix}/pending\nprepare\ncommit\n`,
  });
}
