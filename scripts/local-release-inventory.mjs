import {
  existsSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
// Git hooks export repository-local variables. Carrying them into another
// checkout makes Git compare that checkout against the hook caller's index.
const localGitEnvironment = execFileSync("git", ["rev-parse", "--local-env-vars"], {
  encoding: "utf8",
})
  .trim()
  .split("\n");
function gitOptions(cwd) {
  const env = { ...process.env };
  for (const key of localGitEnvironment) delete env[key];
  return { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
}
const git = (cwd, ...args) => execFileSync("git", args, gitOptions(cwd)).trim();
export function auditReleaseSources({ root, commit, repositories = [root] }) {
  const blockers = [];
  for (const repository of repositories) {
    // Copy only the candidate object when a dedicated builder knows a newer release.
    // No source branch, index, or working file is changed.
    if (
      spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], gitOptions(repository)).status !==
      0
    )
      git(repository, "fetch", "--no-tags", "--no-write-fetch-head", root, commit);

    const entries = git(repository, "worktree", "list", "--porcelain", "-z").split("\0\0");
    for (const entry of entries.filter(Boolean)) {
      const fields = entry.split("\0");
      const worktree = fields.find((field) => field.startsWith("worktree ")).slice(9);
      const status = git(worktree, "status", "--porcelain", "--untracked-files=all");
      if (status) blockers.push({ kind: "dirty", repository, worktree, files: status });
      if (fields.includes("detached")) {
        const head = fields.find((field) => field.startsWith("HEAD ")).slice(5);
        if (
          spawnSync("git", ["merge-base", "--is-ancestor", head, commit], gitOptions(repository))
            .status !== 0
        )
          blockers.push({ kind: "unmerged", repository, ref: worktree, commit: head });
      }
    }
    // A branch parked exactly on upstream contains no separate local work to deliver.
    const upstreamHeads = new Set(
      git(repository, "for-each-ref", "--format=%(objectname)", "refs/remotes/upstream")
        .split("\n")
        .filter(Boolean),
    );
    const refs = git(
      repository,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes/origin",
    );
    for (const line of refs.split("\n").filter(Boolean)) {
      const [ref, head] = line.split(" ");
      if (ref.startsWith("refs/heads/") && upstreamHeads.has(head)) continue;
      if (
        spawnSync("git", ["merge-base", "--is-ancestor", head, commit], gitOptions(repository))
          .status !== 0
      ) {
        blockers.push({ kind: "unmerged", repository, ref, commit: head });
      }
    }
  }
  return { commit, checkedAt: new Date().toISOString(), repositories, blockers };
}
export function releaseBuilderState(env = process.env) {
  return path.resolve(
    env.PASEO_LOCAL_BUILDER_HOME ??
      path.join(homedir(), "Library/Application Support/Paseo Local Builder"),
  );
}

export function assertReleaseInventory({ root, commit, state = releaseBuilderState() }) {
  let report;
  try {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid release commit");
    const configPath = path.join(state, "source-repositories.json");
    if (!existsSync(configPath))
      throw new Error(
        "Configure release sources with paseo-local:auto-build:install before publishing or installing.",
      );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (
      !Array.isArray(config.repositories) ||
      !config.repositories.length ||
      config.repositories.some((value) => typeof value !== "string" || !path.isAbsolute(value))
    )
      throw new Error("Invalid release sources configuration");
    const seen = new Set();
    const repositories = [root, ...config.repositories].filter((repository) => {
      const common = realpathSync(
        git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      );
      if (seen.has(common)) return false;
      seen.add(common);
      return true;
    });
    report = auditReleaseSources({ root, commit, repositories });
  } catch (error) {
    report = {
      commit,
      checkedAt: new Date().toISOString(),
      blockers: [{ kind: "audit-error", message: String(error.message ?? error) }],
    };
  }
  mkdirSync(state, { recursive: true });
  const destination = path.join(state, "source-audit.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n");
  renameSync(temporary, destination);
  if (report.blockers.length) {
    const details = report.blockers.map((blocker) => {
      if (blocker.kind === "dirty") return `${blocker.worktree}: ${blocker.files}`;
      if (blocker.kind === "unmerged")
        return `${blocker.repository}: ${blocker.ref} (${blocker.commit})`;
      return blocker.message;
    });
    throw new Error(
      `Publication bloquée : travaux absents du candidat ou inventaire impossible.\n${details.join("\n")}\nRapport : ${destination}`,
    );
  }
  return report;
}

export function checkLocalReleasePush(input, options) {
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const [, commit, remoteRef] = line.split(/\s+/);
    if (remoteRef !== "refs/heads/main") continue;
    if (commit === "0".repeat(40)) throw new Error("Cannot delete the local release branch");
    assertReleaseInventory({ ...options, commit });
  }
}
