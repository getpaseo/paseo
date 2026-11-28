import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurnChanges } from "@getpaseo/protocol/messages";
import { parseGitRevParsePath } from "../../utils/git-rev-parse-path.js";
import { createRunGitCommand } from "../../utils/run-git-command.js";

const git = createRunGitCommand("turn-changes");
const env = {
  GIT_AUTHOR_NAME: "Paseo",
  GIT_AUTHOR_EMAIL: "snapshots@paseo.invalid",
  GIT_COMMITTER_NAME: "Paseo",
  GIT_COMMITTER_EMAIL: "snapshots@paseo.invalid",
  GIT_OPTIONAL_LOCKS: "0",
};

export async function captureTurnTree(cwd: string): Promise<string | null> {
  const worktree = await git(["rev-parse", "--show-toplevel"], {
    cwd,
    acceptExitCodes: [0, 128],
    timeout: 2_000,
  });
  if (worktree.exitCode !== 0) return null;
  const root = parseGitRevParsePath(worktree.stdout);
  if (root === null) return null;

  const directory = await mkdtemp(join(tmpdir(), "paseo-turn-changes-"));
  const readEnv = { ...env };
  const snapshot = {
    cwd: root,
    envOverlay: { ...env, GIT_INDEX_FILE: join(directory, "index") },
    timeout: 2_000,
  };
  try {
    const indexed = await git(["ls-files", "--stage", "-z"], {
      cwd: root,
      envOverlay: readEnv,
      timeout: 2_000,
    });
    if (indexed.truncated) throw new Error("Turn snapshot index exceeds the Git output limit");
    await git(["read-tree", "--empty"], snapshot);
    if (indexed.stdout) {
      await git(["update-index", "-z", "--index-info"], { ...snapshot, input: indexed.stdout });
    }
    await git(["-c", "core.fsmonitor=false", "add", "--all", "--", ":/"], {
      ...snapshot,
      timeout: 5_000,
    });
    const tree = await git(["write-tree"], snapshot);
    return (
      await git(["commit-tree", tree.stdout.trim()], {
        ...snapshot,
        input: `Paseo turn snapshot ${randomUUID()}\n`,
      })
    ).stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function refPrefix(agentId: string) {
  const key = createHash("sha256").update(agentId).digest("hex");
  return `refs/paseo/turn-changes/${key}`;
}

export async function retainTurnBaseline(cwd: string, agentId: string, before: string) {
  await git(["update-ref", `${refPrefix(agentId)}/pending`, before], { cwd, timeout: 2_000 });
}

export async function releaseTurnBaseline(cwd: string, agentId: string, before: string) {
  await git(["update-ref", "-d", `${refPrefix(agentId)}/pending`, before], {
    cwd,
    acceptExitCodes: [0, 1],
    timeout: 2_000,
  });
}

export async function retainTurnComparison(
  cwd: string,
  agentId: string,
  changes: AgentTurnChanges,
) {
  const ref = refPrefix(agentId);
  await git(["update-ref", "--stdin"], {
    cwd,
    timeout: 2_000,
    input: `update ${ref}/before ${changes.before}\nupdate ${ref}/after ${changes.after}\ndelete ${ref}/pending ${changes.before}\n`,
  });
}

export async function releaseTurnComparison(cwd: string, agentId: string, includePending = false) {
  const ref = refPrefix(agentId);
  const query = await git(["rev-parse", "--git-dir"], {
    cwd,
    timeout: 2_000,
    acceptExitCodes: [0, 128],
  });
  if (query.exitCode !== 0) return;
  await git(["update-ref", "--stdin"], {
    cwd,
    timeout: 2_000,
    input: `delete ${ref}/before\ndelete ${ref}/after\n${includePending ? `delete ${ref}/pending\n` : ""}`,
  });
}
