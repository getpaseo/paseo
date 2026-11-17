import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

export function createPullRequestHistory() {
  const root = resolve(import.meta.dirname, "../../../../.artifacts");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "pr-history-"));
  const remote = join(directory, "remote");
  const cwd = join(directory, "checkout");
  const git = (path: string, args: string[]) =>
    execFileSync("git", args, {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(directory, ["init", remote]);
  const commit = (message: string) =>
    git(remote, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ]);
  commit("workspace");
  const workspaceCommit = git(remote, ["rev-parse", "HEAD"]);
  git(directory, ["clone", remote, cwd]);
  commit("remote branch update");
  const pullRequestCommit = git(remote, ["rev-parse", "HEAD"]);
  return {
    cwd,
    remote,
    workspaceCommit,
    pullRequestCommit,
    git: (args: string[]) => git(cwd, args),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}
