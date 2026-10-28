import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import pino from "pino";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import { expect, test } from "vitest";
import { createNoGitWorkspaceRuntimeSnapshot } from "../test-utils/workspace-git-service-stub.js";
import { createWorkspaceRuntimeStore } from "./index.js";

test("retains, replaces, and removes snapshots by resolved workspace directory", () => {
  const store = createWorkspaceRuntimeStore();
  const cwd = "./workspace";
  const snapshot = createNoGitWorkspaceRuntimeSnapshot(cwd);
  expect(store.get(cwd)).toBeNull();
  store.set(snapshot);
  expect(store.get(resolve(cwd))).toBe(snapshot);
  const replacement = createNoGitWorkspaceRuntimeSnapshot(cwd);
  store.set(replacement);
  expect(store.get(cwd)).toBe(replacement);
  store.remove(resolve(cwd));
  expect(store.get(cwd)).toBeNull();
});

test("retains refreshed Git changes without a workspace subscription", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "paseo-runtime-store-")));
  const repo = path.join(root, "repo");
  let now = Date.now();
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    paseoHome: path.join(root, "home"),
    deps: { now: () => new Date(now) },
  });
  const store = createWorkspaceRuntimeStore();
  service.onSnapshotUpdated((snapshot) => store.set(snapshot));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    writeFileSync(path.join(repo, "README.md"), "# Temp\n");
    git("add", "README.md");
    git(
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "init",
    );
    execFileSync("git", ["init", "-q", "--bare", path.join(root, "remote.git")]);
    git("remote", "add", "origin", path.join(root, "remote.git"));
    git("push", "-q", "-u", "origin", "main");

    writeFileSync(path.join(repo, "README.md"), "# Temp\none\ntwo\n");
    await service.refresh(repo);
    expect(service.getMetrics().workspaceListenerCount).toBe(0);
    expect((await service.getSnapshot(repo)).git.diffStat).toEqual({ additions: 2, deletions: 0 });
    expect(store.get(repo)?.git.diffStat).toEqual({ additions: 2, deletions: 0 });

    now += 3_000;
    writeFileSync(path.join(repo, "README.md"), "# Temp\none\ntwo\nthree\n");
    await service.refresh(repo);
    expect(store.get(repo)?.git.diffStat).toEqual({ additions: 3, deletions: 0 });
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
