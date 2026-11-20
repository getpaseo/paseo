import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { readPaseoWorktreeMetadata } from "../../utils/worktree-metadata.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));
const WORKTRUNK_EXAMPLE = path.join(REPO_ROOT, "plugin-examples", "worktrunk");

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: "pipe" },
  ).trim();
}

async function createRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  await writeFile(path.join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "initial"]);
  return realpath(dir);
}

async function createFakeWorktrunkCli(dir: string, logFile: string): Promise<string> {
  const scriptPath = path.join(dir, "fake-wt.mjs");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
let cwd = process.cwd();
const args = [];
for (let index = 0; index < rawArgs.length; index++) {
  if (rawArgs[index] === "-C" && rawArgs[index + 1]) {
    cwd = rawArgs[++index];
  } else {
    args.push(rawArgs[index]);
  }
}

const command = args[0];
if (command === "switch") {
  const create = args.includes("--create");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
  const pathIdx = args.indexOf("--path");
  const explicitPath = pathIdx !== -1 ? args[pathIdx + 1] : undefined;
  const skip = new Set(["switch", "--create", "--no-cd", "--yes", "--no-hooks", "--format=json"]);
  if (baseIdx !== -1) {
    skip.add("--base");
    skip.add(base);
  }
  if (pathIdx !== -1) {
    skip.add("--path");
    skip.add(explicitPath);
  }
  const branch = args.find((arg) => !skip.has(arg));
  if (!branch) {
    console.error("missing branch");
    process.exit(1);
  }
  if (!create && !explicitPath && branch === "main") {
    appendFileSync(
      ${JSON.stringify(logFile)},
      JSON.stringify({ command: "switch", cwd, branch, action: "existing", args }) + "\\n",
    );
    process.stdout.write(JSON.stringify({ path: cwd, branch, action: "existing" }) + "\\n");
    process.exit(0);
  }
  const repoName = path.basename(cwd);
  const target =
    explicitPath ?? path.join(path.dirname(cwd), \`\${repoName}.\${branch.replaceAll("/", "-")}\`);
  mkdirSync(path.dirname(target), { recursive: true });
  const gitArgs = create
    ? ["worktree", "add", "-b", branch, target, ...(base ? [base] : [])]
    : ["worktree", "add", target, branch];
  execFileSync("git", gitArgs, { cwd, stdio: "pipe" });
  writeFileSync(path.join(target, ".wt-hook-ran"), create ? "pre-start" : "reopen");
  appendFileSync(
    ${JSON.stringify(logFile)},
    JSON.stringify({ command: "switch", cwd, branch, base, create, explicitPath, target, args }) + "\\n",
  );
  process.stdout.write(JSON.stringify({ path: target, branch, action: "created", created_branch: create }) + "\\n");
  if (branch.endsWith("fail-pre-start") && !existsSync(path.join(cwd, ".setup-fixed"))) {
    console.error("pre-start hook failed");
    process.exit(1);
  }
  process.exit(0);
}

if (command === "remove") {
  const target = args.at(-1);
  const keptRefs = execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/paseo/kept-commits"], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  })
    .trim()
    .split("\\n")
    .filter(Boolean);
  appendFileSync(
    ${JSON.stringify(logFile)},
    JSON.stringify({ command: "remove", cwd, target, args, keptRefsCount: keptRefs.length }) + "\\n",
  );
  execFileSync("git", ["worktree", "remove", target, "--force"], { cwd, stdio: "pipe" });
  process.exit(0);
}

if (command === "config" && args[1] === "state" && args[2] === "marker") {
  appendFileSync(
    ${JSON.stringify(logFile)},
    JSON.stringify({ command: "marker", cwd, args: args.slice(3) }) + "\\n",
  );
  process.exit(0);
}

console.error("unexpected wt command: " + rawArgs.join(" "));
process.exit(1);
`,
  );
  if (process.platform === "win32") {
    const cmdPath = path.join(dir, "fake-wt.cmd");
    await writeFile(cmdPath, `@node "${scriptPath}" %*\r\n`);
    return cmdPath;
  }
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test("plugin-examples/worktrunk manages create, before-hook chaining, archive with kept-commits, and restore across daemon restarts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktrunk-example-"));
  const repository = await createRepo(path.join(root, "repo"));
  git(repository, ["branch", "release"]);
  const wtLog = path.join(root, "wt-log.jsonl");
  const fakeWt = await createFakeWorktrunkCli(root, wtLog);
  const previousBin = process.env.WORKTRUNK_BIN;
  process.env.WORKTRUNK_BIN = fakeWt;

  const transformPluginDir = path.join(root, "a-branch-transform");
  await mkdir(transformPluginDir);
  await writeFile(
    path.join(transformPluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "a-branch-transform", requirements: { paseo: ">=0.14.0" } }),
  );
  await writeFile(
    path.join(transformPluginDir, "index.server.ts"),
    `import { existsSync } from "node:fs";
import path from "node:path";
export default function contribute(server) {
  const removeBefore = server.addHook("worktree.create.before", async ({ request }) => {
    if (request.kind !== "branch-off") return;
    return { ...request, branch: "team/" + request.branch, baseRef: "release" };
  });
  const removeAfter = server.addHook("worktree.create.after", async ({ worktree }) => {
    if (worktree.branch === "team/fail-after" && !existsSync(path.join(worktree.sourceCheckout, ".after-fixed"))) {
      throw new Error("Paseo after-hook failed");
    }
  });
  return () => {
    removeBefore();
    removeAfter();
  };
}
`,
  );

  let daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "state"),
    cleanup: false,
  });
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    expect((await client.installDirectoryPlugin(transformPluginDir)).status).toBe("running");
    expect((await client.installDirectoryPlugin(WORKTRUNK_EXAMPLE)).status).toBe("running");

    const created = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, worktreeSlug: "feat-one" },
    });
    expect(created.error).toBeNull();
    const workspaceId = created.workspace!.id;
    const worktreePath = created.workspace!.workspaceDirectory;
    const expectedPath = path.join(path.dirname(repository), "repo.team-feat-one");
    expect(await realpath(worktreePath)).toBe(await realpath(expectedPath));
    expect(git(worktreePath, ["branch", "--show-current"])).toBe("team/feat-one");
    expect(await readFile(path.join(worktreePath, ".wt-hook-ran"), "utf8")).toBe("pre-start");

    const metadata = await readPaseoWorktreeMetadata(worktreePath);
    expect(metadata).toMatchObject({
      baseRefName: "release",
      baseRef: "refs/heads/release",
      worktreeManagerPluginId: "worktrunk",
      changeRequestLookupTarget: {
        headRef: "team/feat-one",
        localBranchName: "team/feat-one",
      },
    });
    // Worktree manager plugins own branch/directory naming, so auto-rename must stay skipped.
    expect(
      metadata && "firstAgentBranchAutoName" in metadata
        ? metadata.firstAgentBranchAutoName
        : undefined,
    ).toBeUndefined();

    // Checking out a branch already checked out in the main repo causes wt to return
    // action="existing", so the example declines and Paseo falls back to Git.
    const checkedOutMain = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, action: "checkout", refName: "main" },
    });
    expect(checkedOutMain.error).toBeNull();
    expect(
      (await readPaseoWorktreeMetadata(checkedOutMain.workspace!.workspaceDirectory))
        ?.worktreeManagerPluginId,
    ).toBeUndefined();
    await client.archiveWorkspace(checkedOutMain.workspace!.id);

    // If wt exits non-zero after creating the worktree (e.g. pre-start hook failure),
    // the example cleans up the partial worktree from stdout before rethrowing.
    const failedPreStart = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, worktreeSlug: "fail-pre-start" },
    });
    expect(failedPreStart.workspace).toBeNull();
    expect(failedPreStart.error).toContain("pre-start hook failed");
    await expect(
      stat(path.join(path.dirname(repository), "repo.team-fail-pre-start")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(path.join(repository, ".setup-fixed"), "");
    const retried = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, worktreeSlug: "fail-pre-start" },
    });
    expect(retried.error).toBeNull();
    const retriedPath = retried.workspace!.workspaceDirectory;
    expect(git(retriedPath, ["branch", "--show-current"])).toBe("team/fail-pre-start");
    expect(await readFile(path.join(retriedPath, ".wt-hook-ran"), "utf8")).toBe("pre-start");

    const rejectedAfter = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, worktreeSlug: "fail-after" },
    });
    expect(rejectedAfter.error).toContain("Paseo after-hook failed");
    expect(git(repository, ["branch", "--list", "team/fail-after"])).toBe("");
    await writeFile(path.join(repository, ".after-fixed"), "");
    const retriedAfter = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, worktreeSlug: "fail-after" },
    });
    expect(retriedAfter.error).toBeNull();
    const retriedAfterPath = retriedAfter.workspace!.workspaceDirectory;
    expect(git(retriedAfterPath, ["branch", "--show-current"])).toBe("team/fail-after");
    expect(await readFile(path.join(retriedAfterPath, ".wt-hook-ran"), "utf8")).toBe("pre-start");

    // Archive delegates removal to `wt remove` (run from repoRoot) AFTER Paseo writes refs/paseo/kept-commits/*.
    const archived = await client.archiveWorkspace(workspaceId);
    expect(archived.error).toBeNull();
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    // Restart daemon and restore: delegates to `wt switch --path <recordedPath> <branch>`.
    await client.close();
    await daemon.close();
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: path.join(root, "state"),
      cleanup: false,
      pluginsEnabled: true,
      plugins: {
        "a-branch-transform": { source: "directory", path: transformPluginDir, enabled: true },
        worktrunk: { source: "directory", path: WORKTRUNK_EXAMPLE, enabled: true },
      },
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();

    await client.restoreWorkspace(workspaceId);
    expect(git(worktreePath, ["branch", "--show-current"])).toBe("team/feat-one");
    expect(await readFile(path.join(worktreePath, ".wt-hook-ran"), "utf8")).toBe("reopen");
    expect(await readPaseoWorktreeMetadata(worktreePath)).toMatchObject({
      worktreeManagerPluginId: "worktrunk",
      baseRefName: "release",
    });

    const events = (await readFile(wtLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({
        command: "switch",
        branch: "team/feat-one",
        base: "refs/heads/release",
        create: true,
      }),
      expect.objectContaining({
        command: "switch",
        branch: "main",
        action: "existing",
      }),
      expect.objectContaining({
        command: "switch",
        branch: "team/fail-pre-start",
        create: true,
      }),
      expect.objectContaining({
        command: "remove",
        cwd: repository,
        args: expect.arrayContaining([
          "remove",
          "--foreground",
          "--no-delete-branch",
          "--no-hooks",
          "--force",
        ]),
      }),
      expect.objectContaining({
        command: "switch",
        branch: "team/fail-pre-start",
        create: true,
      }),
      expect.objectContaining({ command: "switch", branch: "team/fail-after", create: true }),
      expect.objectContaining({
        command: "remove",
        target: path.join(path.dirname(repository), "repo.team-fail-after"),
      }),
      expect.objectContaining({ command: "switch", branch: "team/fail-after", create: true }),
      expect.objectContaining({
        command: "remove",
        cwd: repository,
        keptRefsCount: 1,
        args: expect.arrayContaining([
          "remove",
          "--foreground",
          "--no-delete-branch",
          "--yes",
          "--force",
        ]),
      }),
      expect.objectContaining({
        command: "switch",
        branch: "team/feat-one",
        create: false,
        explicitPath: expect.any(String),
      }),
    ]);
    expect(path.resolve(events.at(-1).explicitPath)).toBe(await realpath(worktreePath));
  } finally {
    if (previousBin === undefined) delete process.env.WORKTRUNK_BIN;
    else process.env.WORKTRUNK_BIN = previousBin;
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("worktree manager supports decline fallback, rollback delegation, and disabled-plugin fallback on archive and restore", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-manager-fallback-"));
  const repository = await createRepo(path.join(root, "repo"));
  const eventsFile = path.join(root, "events.jsonl");

  const pluginDir = path.join(root, "custom-manager");
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "custom-manager", requirements: { paseo: ">=0.16.0" } }),
  );
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

export default function contribute(server) {
  const removeManager = server.registerWorktreeManager({
    async create(request) {
      if (request.branch === "decline-me") return;
      const target = path.join(path.dirname(request.repoRoot), "managed-" + request.branch);
      execFileSync("git", ["worktree", "add", "-b", request.branch, target, request.baseRef], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ op: "create", branch: request.branch, target }) + "\\n");
      return { type: "created", path: target };
    },
    async restore(request) {
      execFileSync("git", ["worktree", "add", "-b", "wrong-restore", request.path, "main"], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "restored", path: request.path };
    },
    async remove(request) {
      appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ op: "remove", reason: request.reason, path: request.path }) + "\\n");
      execFileSync("git", ["worktree", "remove", request.path, "--force"], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "removed" };
    },
  });
  const removeAfter = server.addHook("worktree.create.after", async ({ worktree }) => {
    if (worktree.branch === "abort-after") {
      throw new Error("rejected after creation");
    }
  });
  return () => {
    removeAfter();
    removeManager();
  };
}
`,
  );

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "state"),
    cleanup: false,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    expect((await client.installDirectoryPlugin(pluginDir)).status).toBe("running");

    // 1. Declining falls back cleanly to Paseo's built-in git worktree creation.
    const declined = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "decline-me" },
    });
    expect(declined.error).toBeNull();
    const declinedMeta = await readPaseoWorktreeMetadata(declined.workspace!.workspaceDirectory);
    expect(declinedMeta?.worktreeManagerPluginId).toBeUndefined();

    // 2. Failure in worktree.create.after rolls back through the manager's remove(reason: "rollback").
    const aborted = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "abort-after" },
    });
    expect(aborted.workspace).toBeNull();
    expect(aborted.error).toContain("rejected after creation");
    await expect(
      stat(path.join(path.dirname(repository), "managed-abort-after")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    // 3. Create a managed worktree, then disable the plugin: archive & restore fall back to Git.
    const managed = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "survive-disable" },
    });
    expect(managed.error).toBeNull();
    const managedPath = managed.workspace!.workspaceDirectory;
    await client.disablePlugin("custom-manager");

    const archived = await client.archiveWorkspace(managed.workspace!.id);
    expect(archived.error).toBeNull();
    await expect(stat(managedPath)).rejects.toMatchObject({ code: "ENOENT" });

    await client.enablePlugin("custom-manager");
    await expect(client.restoreWorkspace(managed.workspace!.id)).rejects.toThrow(
      "expected branch survive-disable",
    );
    await expect(stat(managedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await client.disablePlugin("custom-manager");

    await client.restoreWorkspace(managed.workspace!.id);
    expect(git(managedPath, ["branch", "--show-current"])).toBe("survive-disable");
    // Re-enabling the plugin must not route removal of a Git-restored worktree back to the plugin.
    await client.enablePlugin("custom-manager");
    await client.archiveWorkspace(managed.workspace!.id);
    await expect(stat(managedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const events = (await readFile(eventsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({ op: "create", branch: "abort-after" }),
      expect.objectContaining({ op: "remove", reason: "rollback" }),
      expect.objectContaining({ op: "create", branch: "survive-disable" }),
      expect.objectContaining({ op: "remove", reason: "rollback" }),
    ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("worktree manager rejects pre-existing worktrees, detached HEAD, wrong repos, and non-worktree paths without modifying them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-manager-guards-"));
  const repository = await createRepo(path.join(root, "repo"));
  const otherRepo = await createRepo(path.join(root, "other-repo"));

  // Pre-existing manual worktree the user created outside Paseo.
  const existingManual = path.join(root, "manual-existing");
  git(repository, ["worktree", "add", "-b", "manual-branch", existingManual, "main"]);

  const plainDir = path.join(root, "not-a-worktree");
  await mkdir(plainDir);

  const pluginDir = path.join(root, "bad-manager");
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "bad-manager", requirements: { paseo: ">=0.16.0" } }),
  );
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import path from "node:path";

export default function contribute(server) {
  return server.registerWorktreeManager({
    async create(request) {
      if (request.branch === "existing") {
        return { type: "created", path: ${JSON.stringify(existingManual)} };
      }
      if (request.branch === "plain-dir") {
        return { type: "created", path: ${JSON.stringify(plainDir)} };
      }
      if (request.branch === "other-repo") {
        const target = path.join(${JSON.stringify(root)}, "other-wt");
        execFileSync("git", ["worktree", "add", "-b", "other-wt", target, "main"], {
          cwd: ${JSON.stringify(otherRepo)},
          stdio: "pipe",
        });
        return { type: "created", path: target };
      }
      if (request.branch === "detached") {
        const target = path.join(${JSON.stringify(root)}, "detached-wt");
        execFileSync("git", ["worktree", "add", "--detach", target, "main"], {
          cwd: request.repoRoot,
          stdio: "pipe",
        });
        return { type: "created", path: target };
      }
      if (request.branch === "concurrent") {
        const root = path.dirname(request.repoRoot);
        const { writeFileSync, existsSync } = await import("node:fs");
        writeFileSync(path.join(root, "manager-started"), "");
        const deadline = Date.now() + 10_000;
        while (!existsSync(path.join(root, "reject-manager"))) {
          if (Date.now() > deadline) throw new Error("test did not release manager");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("manager rejected checkout");
      }
      if (request.branch === "relative") {
        return { type: "created", path: "relative/path" };
      }
      return;
    },
  });
}
`,
  );

  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    expect((await client.installDirectoryPlugin(pluginDir)).status).toBe("running");

    const cases: Array<[string, string]> = [
      ["existing", "already-existing worktree"],
      ["plain-dir", "did not create a Git worktree"],
      ["other-repo", "outside the repository"],
      ["detached", "detached HEAD"],
      ["relative", "relative path"],
    ];
    for (const [branchName, expectedError] of cases) {
      const created = await client.createWorkspace({
        source: { kind: "worktree", cwd: repository, branchName },
      });
      expect(created.workspace).toBeNull();
      expect(created.error).toContain(expectedError);
    }

    // The pre-existing manual worktree must stay untouched and un-owned by Paseo.
    expect(await readPaseoWorktreeMetadata(existingManual)).toBeNull();
    expect((await stat(existingManual)).isDirectory()).toBe(true);
    // The newly created detached worktree failed adoption and must be rolled back cleanly.
    await expect(stat(path.join(root, "detached-wt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(repository, ["worktree", "list", "--porcelain"])).not.toContain("detached-wt");
    const pending = client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "concurrent" },
    });
    await expect
      .poll(() =>
        stat(path.join(root, "manager-started")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const concurrent = path.join(root, "concurrent-manual");
    git(repository, ["worktree", "add", "-b", "concurrent", concurrent, "main"]);
    await writeFile(path.join(concurrent, "local.txt"), "uncommitted work");
    await writeFile(path.join(root, "reject-manager"), "");
    const rejected = await pending;
    expect(rejected.workspace).toBeNull();
    expect(rejected.error).toContain("manager rejected checkout");
    expect(await readFile(path.join(concurrent, "local.txt"), "utf8")).toBe("uncommitted work");
    expect(git(concurrent, ["branch", "--show-current"])).toBe("concurrent");
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("worktree manager rejects duplicate registration and fails removal when the directory remains on disk", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-manager-edge-"));
  const repository = await createRepo(path.join(root, "repo"));

  const dupPluginDir = path.join(root, "dup-manager");
  await mkdir(dupPluginDir);
  await writeFile(
    path.join(dupPluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "dup-manager", requirements: { paseo: ">=0.16.0" } }),
  );
  await writeFile(
    path.join(dupPluginDir, "index.server.ts"),
    `export default function contribute(server) {
  server.registerWorktreeManager({ async create() {} });
  server.registerWorktreeManager({ async create() {} });
  return () => {};
}
`,
  );

  const leakyRemoveDir = path.join(root, "leaky-remove");
  await mkdir(leakyRemoveDir);
  await writeFile(
    path.join(leakyRemoveDir, "paseo-plugin.json"),
    JSON.stringify({ id: "leaky-remove", requirements: { paseo: ">=0.16.0" } }),
  );
  await writeFile(
    path.join(leakyRemoveDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import path from "node:path";

export default function contribute(server) {
  return server.registerWorktreeManager({
    async create(request) {
      const target = path.join(path.dirname(request.repoRoot), "leaky-" + request.branch);
      execFileSync("git", ["worktree", "add", "-b", request.branch, target, request.baseRef], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "created", path: target };
    },
    async remove() {
      // Claims removed without deleting the directory.
      return { type: "removed" };
    },
  });
}
`,
  );

  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });

    await expect(client.installDirectoryPlugin(dupPluginDir)).rejects.toThrow(
      "Plugin already registered a worktree manager",
    );

    expect((await client.installDirectoryPlugin(leakyRemoveDir)).status).toBe("running");
    const created = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "still-here" },
    });
    expect(created.error).toBeNull();
    const worktreePath = created.workspace!.workspaceDirectory;

    const archived = await client.archiveWorkspace(created.workspace!.id);
    expect(archived.error).toBeNull();
    // Removal failure keeps the directory instead of silently deleting behind the manager.
    expect((await stat(worktreePath)).isDirectory()).toBe(true);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("untrusted workspaces pass untrusted=true to worktree manager remove and restore, and worktrunk skips hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktrunk-untrusted-"));
  const repository = await createRepo(path.join(root, "repo"));
  const wtLog = path.join(root, "wt-log.jsonl");
  const fakeWt = await createFakeWorktrunkCli(root, wtLog);
  const previousBin = process.env.WORKTRUNK_BIN;
  process.env.WORKTRUNK_BIN = fakeWt;

  const stateDir = path.join(root, "state");
  let daemon = await createTestPaseoDaemon({
    paseoHomeRoot: stateDir,
    cleanup: false,
  });
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    expect((await client.installDirectoryPlugin(WORKTRUNK_EXAMPLE)).status).toBe("running");

    git(repository, ["branch", "existing-topic"]);
    git(repository, ["commit", "--allow-empty", "-m", "advance main"]);
    const collision = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "existing-topic" },
    });
    expect(collision.error).toBeNull();
    const collisionPath = collision.workspace!.workspaceDirectory;
    expect(git(collisionPath, ["branch", "--show-current"])).not.toBe("existing-topic");
    expect(git(collisionPath, ["rev-parse", "HEAD"])).toBe(
      git(repository, ["rev-parse", "existing-topic"]),
    );
    await client.archiveWorkspace(collision.workspace!.id);

    const remote = await createRepo(path.join(root, "remote"));
    git(repository, ["remote", "add", "origin", remote]);
    git(repository, ["fetch", "origin", "main"]);
    const cached = git(repository, ["rev-parse", "refs/remotes/origin/main"]);
    git(remote, ["commit", "--allow-empty", "-m", "advance remote main"]);
    const remoteTip = git(remote, ["rev-parse", "HEAD"]);
    expect(cached).not.toBe(remoteTip);

    const created = await client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repository,
        action: "branch-off",
        baseBranch: "refs/remotes/origin/main",
        branchName: "fork-pr-branch",
      },
    });
    expect(created.error).toBeNull();
    const workspaceId = created.workspace!.id;
    const worktreePath = created.workspace!.workspaceDirectory;

    expect(git(worktreePath, ["rev-parse", "HEAD"])).toBe(remoteTip);

    // Mark the persisted workspace record as originating from an untrusted fork PR and reload daemon.
    await client.close();
    await daemon.close();
    const workspacesPath = path.join(daemon.paseoHome, "projects", "workspaces.json");
    const records = JSON.parse(await readFile(workspacesPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    for (const record of records) {
      if (record.workspaceId === workspaceId) {
        record.untrustedSource = {
          kind: "change_request",
          forge: "github",
          number: 42,
          headRepository: "fork-owner/repo",
        };
      }
    }
    await writeFile(workspacesPath, JSON.stringify(records, null, 2));

    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: stateDir,
      cleanup: false,
      pluginsEnabled: true,
      plugins: {
        worktrunk: { source: "directory", path: WORKTRUNK_EXAMPLE, enabled: true },
      },
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();

    const archived = await client.archiveWorkspace(workspaceId);
    expect(archived.error).toBeNull();
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    await client.restoreWorkspace(workspaceId);
    expect(git(worktreePath, ["branch", "--show-current"])).toBe("fork-pr-branch");

    const events = (await readFile(wtLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { command: string; cwd: string; args: string[] });
    const removeEvent = events.find((event) => event.command === "remove");
    expect(removeEvent).toBeDefined();
    expect(removeEvent!.cwd).toBe(repository);
    expect(removeEvent!.args).toContain("--no-hooks");
    expect(removeEvent!.args).not.toContain("--yes");

    const restoreEvent = events.at(-1);
    expect(restoreEvent?.command).toBe("switch");
    expect(restoreEvent?.args).toContain("--no-hooks");
    expect(restoreEvent?.args).not.toContain("--yes");
  } finally {
    if (previousBin === undefined) delete process.env.WORKTRUNK_BIN;
    else process.env.WORKTRUNK_BIN = previousBin;
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
