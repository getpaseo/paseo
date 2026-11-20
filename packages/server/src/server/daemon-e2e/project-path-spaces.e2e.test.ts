import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// Windows does not preserve trailing spaces in folder names.
const testOnPosix = test.skipIf(process.platform === "win32");

let client: DaemonClient;
let repoDir: string;
let projectId: string;

beforeEach(async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-project-path-spaces-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  repoDir = join(root, "repo ");
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Paseo Test",
      "-c",
      "user.email=test@getpaseo.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repoDir, stdio: "pipe" },
  );
  const daemon = await createTestPaseoDaemon();
  onTestFinished(() => daemon.close());
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const testClient = client;
  onTestFinished(() => testClient.close());
  await client.connect();
  const added = await client.addProject(repoDir);
  expect(added.error).toBeNull();
  expect(added.project?.projectRootPath).toBe(repoDir);
  projectId = added.project!.projectId;
});

testOnPosix("a project folder ending in a space keeps its Git status", async () => {
  const opened = await client.createWorkspace({
    source: { kind: "directory", path: repoDir, projectId },
  });
  expect(opened.error).toBeNull();
  expect(opened.workspace?.workspaceDirectory).toBe(repoDir);
  const status = await client.getCheckoutStatus(repoDir);
  expect(status.isGit).toBe(true);
  expect(status.repoRoot).toBe(repoDir);
  expect(status.currentBranch).toBe("main");
});

testOnPosix("a project folder ending in a space can create a worktree", async () => {
  const created = await client.createWorkspace({
    source: {
      kind: "worktree",
      projectId,
      action: "branch-off",
      branchName: "feature/spaces",
      baseBranch: "main",
    },
  });
  expect(created.error).toBeNull();
  expect(created.workspace?.gitRuntime?.currentBranch).toBe("feature/spaces");
});
