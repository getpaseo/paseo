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
    cwd = path.resolve(rawArgs[++index]);
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
  const target = path.resolve(args.at(-1));
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
}, 90_000);

test("worktree manager supports decline fallback, rollback delegation, and disabled-plugin fallback on archive and restore", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-manager-fallback-"));
  const repository = await createRepo(path.join(root, "repo"));
  const eventsFile = path.join(root, "events.jsonl");

  const pluginDir = path.join(root, "custom-manager");
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "custom-manager", requirements: { paseo: ">=0.17.0" } }),
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
    JSON.stringify({ id: "bad-manager", requirements: { paseo: ">=0.17.0" } }),
  );
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
      if (request.branch === "ancestor") {
        return { type: "created", path: path.dirname(request.repoRoot) };
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
      ["relative", "Plugin bad-manager worktree.create failed: The returned path is relative"],
      [
        "ancestor",
        "Plugin bad-manager worktree.create failed: The returned path is an ancestor of the repository",
      ],
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
    const managerStarted = expect
      .poll(
        () =>
          stat(path.join(root, "manager-started")).then(
            () => true,
            () => false,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await Promise.race([
      managerStarted,
      pending.then(({ error }) => {
        throw new Error(`Worktree creation finished before the manager was released: ${error}`);
      }),
    ]);
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
    JSON.stringify({ id: "dup-manager", requirements: { paseo: ">=0.17.0" } }),
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
    JSON.stringify({ id: "leaky-remove", requirements: { paseo: ">=0.17.0" } }),
  );
  await writeFile(
    path.join(leakyRemoveDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
    async remove({ branch }) {
      if (branch === "remove-throws") throw new Error("Remove failed before touching the checkout");
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
    for (const branchName of ["still-here", "remove-throws"]) {
      const created = await client.createWorkspace({
        source: { kind: "worktree", cwd: repository, branchName },
      });
      expect(created.error).toBeNull();
      const worktreePath = created.workspace!.workspaceDirectory;

      const archived = await client.archiveWorkspace(created.workspace!.id);
      expect(archived.error).toBeNull();
      expect((await stat(worktreePath)).isDirectory()).toBe(true);
    }
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

    // Sibling workspace created on a subdirectory of the same unapproved fork checkout must also
    // skip hooks on both last-sibling archive and subsequent restore.
    const subDir = path.join(worktreePath, "packages", "sub");
    await mkdir(subDir, { recursive: true });
    await writeFile(path.join(subDir, "README.md"), "sub");
    git(worktreePath, ["add", "packages/sub/README.md"]);
    git(worktreePath, ["commit", "-m", "add subpackage"]);
    const siblingCreated = await client.createWorkspace({
      source: { kind: "directory", path: subDir },
    });
    expect(siblingCreated.error).toBeNull();
    const siblingId = siblingCreated.workspace!.id;

    expect((await client.archiveWorkspace(workspaceId)).error).toBeNull();
    expect((await stat(worktreePath)).isDirectory()).toBe(true);

    expect((await client.archiveWorkspace(siblingId)).error).toBeNull();
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    await client.restoreWorkspace(siblingId);
    expect(git(worktreePath, ["branch", "--show-current"])).toBe("fork-pr-branch");

    const allEvents = (await readFile(wtLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { command: string; cwd: string; args: string[] });
    const siblingEvents = allEvents.slice(events.length);
    const siblingRemoveEvent = siblingEvents.find((event) => event.command === "remove");
    expect(siblingRemoveEvent).toBeDefined();
    expect(siblingRemoveEvent!.args).toContain("--no-hooks");
    expect(siblingRemoveEvent!.args).not.toContain("--yes");
    const siblingRestoreEvent = siblingEvents.at(-1);
    expect(siblingRestoreEvent?.command).toBe("switch");
    expect(siblingRestoreEvent?.args).toContain("--no-hooks");
    expect(siblingRestoreEvent?.args).not.toContain("--yes");
  } finally {
    if (previousBin === undefined) delete process.env.WORKTRUNK_BIN;
    else process.env.WORKTRUNK_BIN = previousBin;
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("concurrent restores across two daemon clients wait for the in-flight manager restore and share its failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-restore-race-"));
  const repository = await createRepo(path.join(root, "repo"));
  const dirCreatedMarker = path.join(root, "restore-dir-created");
  const releaseMarker = path.join(root, "release-restore");
  const allowSucceedMarker = path.join(root, "allow-restore-succeed");

  const pluginDir = path.join(root, "slow-restore-manager");
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "slow-restore-manager", requirements: { paseo: ">=0.17.0" } }),
  );
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export default function contribute(server) {
  return server.registerWorktreeManager({
    async create(request) {
      const target = path.join(path.dirname(request.repoRoot), "managed-" + request.branch);
      execFileSync("git", ["worktree", "add", "-b", request.branch, target, request.baseRef], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "created", path: target };
    },
    async remove(request) {
      execFileSync("git", ["worktree", "remove", request.path, "--force"], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "removed" };
    },
    async restore(request) {
      if (request.target.type !== "branch") return;
      execFileSync("git", ["worktree", "add", request.path, request.target.branch], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      if (!existsSync(${JSON.stringify(allowSucceedMarker)})) {
        writeFileSync(${JSON.stringify(dirCreatedMarker)}, "ready");
        const deadline = Date.now() + 15_000;
        while (!existsSync(${JSON.stringify(releaseMarker)})) {
          if (Date.now() > deadline) throw new Error("test did not release restore");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        execFileSync("git", ["worktree", "remove", request.path, "--force"], {
          cwd: request.repoRoot,
          stdio: "pipe",
        });
        throw new Error("restore setup failed");
      }
      return { type: "restored", path: request.path };
    },
  });
}
`,
  );

  const daemon = await createTestPaseoDaemon();
  const client1 = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const client2 = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await Promise.all([client1.connect(), client2.connect()]);
    await client1.patchDaemonConfig({ pluginsEnabled: true });
    expect((await client1.installDirectoryPlugin(pluginDir)).status).toBe("running");

    const created = await client1.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "race-branch" },
    });
    expect(created.error).toBeNull();
    const workspaceId = created.workspace!.id;
    const worktreePath = created.workspace!.workspaceDirectory;

    const archived = await client1.archiveWorkspace(workspaceId);
    expect(archived.error).toBeNull();
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    // Start first restore and wait until the worktree directory exists on disk while setup is still paused.
    const firstRestore = client1.restoreWorkspace(workspaceId);
    await expect
      .poll(
        () =>
          stat(dirCreatedMarker).then(
            () => true,
            () => false,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    expect((await stat(worktreePath)).isDirectory()).toBe(true);

    // Second client restores while the first is still running: must wait instead of prematurely unarchiving.
    let secondSettled = false;
    const secondRestore = client2.restoreWorkspace(workspaceId);
    void secondRestore.then(
      () => {
        secondSettled = true;
        return undefined;
      },
      () => {
        secondSettled = true;
        return undefined;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondSettled).toBe(false);

    // Release the first restore to fail and roll back its partial directory: both callers must reject.
    await writeFile(releaseMarker, "go");
    await expect(firstRestore).rejects.toThrow("restore setup failed");
    await expect(secondRestore).rejects.toThrow("restore setup failed");
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    // Workspace remains archived and can be restored cleanly on retry.
    const recovery = await client1.inspectWorkspaceRecovery(workspaceId);
    expect(recovery.kind).toBe("recoverable");
    await writeFile(allowSucceedMarker, "ok");
    await client1.restoreWorkspace(workspaceId);
    expect(git(worktreePath, ["branch", "--show-current"])).toBe("race-branch");
  } finally {
    await client1.close();
    await client2.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("restore waits for an in-flight CLI worktree archive remove before recreating the checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-cli-archive-race-"));
  const repository = await createRepo(path.join(root, "repo"));
  const removeStartedMarker = path.join(root, "remove-started");
  const releaseRemoveMarker = path.join(root, "release-remove");

  const pluginDir = path.join(root, "slow-remove-manager");
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "slow-remove-manager", requirements: { paseo: ">=0.17.0" } }),
  );
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export default function contribute(server) {
  return server.registerWorktreeManager({
    async create(request) {
      const target = path.join(path.dirname(request.repoRoot), "managed-" + request.branch);
      execFileSync("git", ["worktree", "add", "-b", request.branch, target, request.baseRef], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "created", path: target };
    },
    async remove(request) {
      writeFileSync(${JSON.stringify(removeStartedMarker)}, "paused");
      const deadline = Date.now() + 15_000;
      while (!existsSync(${JSON.stringify(releaseRemoveMarker)})) {
        if (Date.now() > deadline) throw new Error("test did not release remove");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      execFileSync("git", ["worktree", "remove", request.path, "--force"], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "removed" };
    },
    async restore(request) {
      if (request.target.type !== "branch") return;
      execFileSync("git", ["worktree", "add", request.path, request.target.branch], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "restored", path: request.path };
    },
  });
}
`,
  );

  const daemon = await createTestPaseoDaemon();
  const client1 = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const client2 = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await Promise.all([client1.connect(), client2.connect()]);
    await client1.patchDaemonConfig({ pluginsEnabled: true });
    expect((await client1.installDirectoryPlugin(pluginDir)).status).toBe("running");

    const created = await client1.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "cli-race-branch" },
    });
    expect(created.error).toBeNull();
    const workspaceId = created.workspace!.id;
    const worktreePath = created.workspace!.workspaceDirectory;

    // Client 1 starts a CLI worktree archive (scope: "worktree"); pause inside manager.remove after the record is archived.
    const cliArchive = client1.archivePaseoWorktree({ worktreePath, scope: "worktree" });
    await expect
      .poll(
        () =>
          stat(removeStartedMarker).then(
            () => true,
            () => false,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Client 2 opens the project path while manager.remove holds the checkout: openProject must wait,
    // then reject with directory_not_found instead of unarchiving a deleted checkout.
    let openSettled = false;
    const openPromise = client2.openProject(worktreePath);
    void openPromise.then(
      () => {
        openSettled = true;
        return undefined;
      },
      () => {
        openSettled = true;
        return undefined;
      },
    );

    // Client 2 also restores while manager.remove still holds the checkout: restore must wait, not unarchive early.
    let restoreSettled = false;
    const restorePromise = client2.restoreWorkspace(workspaceId);
    void restorePromise.then(
      () => {
        restoreSettled = true;
        return undefined;
      },
      () => {
        restoreSettled = true;
        return undefined;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(openSettled).toBe(false);
    expect(restoreSettled).toBe(false);

    // Release manager.remove to delete the checkout; openProject sees it gone, and restore recreates it cleanly.
    await writeFile(releaseRemoveMarker, "go");
    const archiveResult = await cliArchive;
    expect(archiveResult.success).toBe(true);
    const openResult = await openPromise;
    expect(openResult.workspace).toBeNull();
    expect(openResult.errorCode).toBe("directory_not_found");
    await restorePromise;

    expect((await stat(worktreePath)).isDirectory()).toBe(true);
    expect(git(worktreePath, ["branch", "--show-current"])).toBe("cli-race-branch");
  } finally {
    await client1.close();
    await client2.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("git fallback restore clears manager ownership across sibling workspaces sharing a checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-sibling-owner-"));
  const repository = await createRepo(path.join(root, "repo"));
  await mkdir(path.join(repository, "packages", "sub"), { recursive: true });
  await writeFile(path.join(repository, "packages", "sub", "README.md"), "sub");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "add subpackage"]);
  const removeCallsFile = path.join(root, "remove-calls.log");

  const pluginDir = path.join(root, "owner-tracking-manager");
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "owner-tracking-manager", requirements: { paseo: ">=0.17.0" } }),
  );
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

export default function contribute(server) {
  return server.registerWorktreeManager({
    async create(request) {
      const target = path.join(path.dirname(request.repoRoot), "managed-" + request.branch);
      execFileSync("git", ["worktree", "add", "-b", request.branch, target, request.baseRef], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "created", path: target };
    },
    async remove(request) {
      appendFileSync(${JSON.stringify(removeCallsFile)}, request.path + "\\n");
      execFileSync("git", ["worktree", "remove", request.path, "--force"], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
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
    expect((await client.installDirectoryPlugin(pluginDir)).status).toBe("running");

    const created = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "shared-checkout" },
    });
    expect(created.error).toBeNull();
    const firstWorkspaceId = created.workspace!.id;
    const worktreePath = created.workspace!.workspaceDirectory;

    // Create a second workspace on a subdirectory of the same managed checkout, sharing ownership.
    const secondCreated = await client.createWorkspace({
      source: { kind: "directory", path: path.join(worktreePath, "packages", "sub") },
    });
    expect(secondCreated.error).toBeNull();
    const secondWorkspaceId = secondCreated.workspace!.id;

    // Persist the same manager owner on both records, disable the plugin, archive both, and restore via Git fallback.
    await client.disablePlugin("owner-tracking-manager");
    const archived = await client.archivePaseoWorktree({ worktreePath, scope: "worktree" });
    expect(archived.success).toBe(true);
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });

    // First restore recreates via Git fallback; second restore joins the existing checkout.
    await client.restoreWorkspace(firstWorkspaceId);
    await client.restoreWorkspace(secondWorkspaceId);
    expect((await stat(worktreePath)).isDirectory()).toBe(true);

    // Re-enable the plugin and archive both workspaces: neither should invoke the former manager's remove.
    await client.enablePlugin("owner-tracking-manager");
    expect((await client.archiveWorkspace(firstWorkspaceId)).error).toBeNull();
    expect((await client.archiveWorkspace(secondWorkspaceId)).error).toBeNull();
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(removeCallsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("undo after a restore queued behind a running archive still cancels before checkout removal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-restore-undo-race-"));
  const repository = await createRepo(path.join(root, "repo"));
  const teardownStartedMarker = path.join(root, "teardown-started");
  const releaseTeardownMarker = path.join(root, "release-teardown");
  const teardownScript = path.join(root, "wait-teardown.mjs");
  await writeFile(
    teardownScript,
    `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(teardownStartedMarker)}, "paused");
const deadline = Date.now() + 15_000;
while (!existsSync(${JSON.stringify(releaseTeardownMarker)})) {
  if (Date.now() > deadline) throw new Error("test did not release teardown");
  await new Promise((resolve) => setTimeout(resolve, 20));
}
`,
  );
  await writeFile(
    path.join(repository, "paseo.json"),
    JSON.stringify({
      worktree: {
        teardown: [`node "${teardownScript}"`],
      },
    }),
  );
  git(repository, ["add", "paseo.json"]);
  git(repository, ["commit", "-m", "add teardown hook"]);

  const daemon = await createTestPaseoDaemon();
  const client1 = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const client2 = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await Promise.all([client1.connect(), client2.connect()]);
    const created = await client1.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "undo-race-branch" },
    });
    expect(created.error).toBeNull();
    const workspaceId = created.workspace!.id;
    const worktreePath = created.workspace!.workspaceDirectory;
    const uncommittedFile = path.join(worktreePath, "uncommitted.txt");
    await writeFile(uncommittedFile, "keep-me");

    const archivePromise = client1.archiveWorkspace(workspaceId);
    await expect
      .poll(
        () =>
          stat(teardownStartedMarker).then(
            () => true,
            () => false,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Send Restore, then Undo while teardown is still running.
    const restorePromise = client2.restoreWorkspace(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const undoPromise = client1.undoWorkspaceArchive(workspaceId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await writeFile(releaseTeardownMarker, "go");
    const archiveResult = await archivePromise;
    expect(archiveResult.canceled).toBe(true);
    await Promise.all([restorePromise, undoPromise]);

    expect(await readFile(uncommittedFile, "utf8")).toBe("keep-me");
  } finally {
    await client1.close();
    await client2.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("worktree manager rejects nested and enclosing secondary worktrees without deleting existing work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-nested-reject-"));
  const repository = await createRepo(path.join(root, "repo"));
  const worktreesBase = path.join(root, "wt-layout");

  const pluginDir = path.join(root, "nested-layout-manager");
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "nested-layout-manager", requirements: { paseo: ">=0.17.0" } }),
  );
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default function contribute(server) {
  return server.registerWorktreeManager({
    async create(request) {
      let target;
      if (request.branch === "team") {
        target = path.join(${JSON.stringify(worktreesBase)}, "team");
      } else if (request.branch === "topic") {
        target = path.join(${JSON.stringify(worktreesBase)}, "team", "topic");
      } else if (request.branch === "inner") {
        target = path.join(${JSON.stringify(worktreesBase)}, "outer", "inner");
      } else if (request.branch === "outer") {
        target = path.join(${JSON.stringify(worktreesBase)}, "outer");
        const staged = path.join(${JSON.stringify(worktreesBase)}, "outer-staged");
        execFileSync("git", ["worktree", "add", "-b", request.branch, staged, request.baseRef], {
          cwd: request.repoRoot,
          stdio: "pipe",
        });
        fs.cpSync(staged, target, { recursive: true, force: true });
        fs.rmSync(staged, { recursive: true, force: true });
        execFileSync("git", ["worktree", "repair", target], {
          cwd: request.repoRoot,
          stdio: "pipe",
        });
        return { type: "created", path: target };
      } else {
        return;
      }
      execFileSync("git", ["worktree", "add", "-b", request.branch, target, request.baseRef], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "created", path: target };
    },
    async remove(request) {
      execFileSync("git", ["worktree", "remove", request.path, "--force"], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
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
    expect((await client.installDirectoryPlugin(pluginDir)).status).toBe("running");

    // 1. Reject creating a secondary worktree nested inside an existing secondary worktree.
    const team = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "team" },
    });
    expect(team.error).toBeNull();
    const teamPath = team.workspace!.workspaceDirectory;
    await writeFile(path.join(teamPath, "team-dirty.txt"), "team-work");

    const nested = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "topic" },
    });
    expect(nested.error).toContain("nested inside an existing worktree");
    await expect(stat(path.join(teamPath, "topic"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(teamPath, "team-dirty.txt"), "utf8")).toBe("team-work");

    // 2. Reject creating a worktree enclosing an existing worktree without deleting the inner worktree.
    const inner = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "inner" },
    });
    expect(inner.error).toBeNull();
    const innerPath = inner.workspace!.workspaceDirectory;
    await writeFile(path.join(innerPath, "inner-dirty.txt"), "inner-work");

    const outer = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "outer" },
    });
    expect(outer.error).toContain("enclosing an existing worktree");
    expect(await readFile(path.join(innerPath, "inner-dirty.txt"), "utf8")).toBe("inner-work");
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

async function addNestedGitContent(checkout: string, dependency: string, middle: string) {
  await writeFile(path.join(checkout, ".gitignore"), ".build/\n");
  const checkouts = path.join(checkout, ".build", "checkouts");
  await mkdir(checkouts, { recursive: true });
  git(checkout, ["clone", dependency, path.join(checkouts, "dependency")]);
  git(checkout, ["-c", "protocol.file.allow=always", "submodule", "add", middle, "middle"]);
  git(checkout, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
  expect((await stat(path.join(checkout, "middle", "leaf", "README.md"))).isFile()).toBe(true);
}

test("built-in archive removes the worktree with dependency clones and recursive submodules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-built-in-archive-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    const repository = await createRepo(path.join(root, "repo"));
    const leaf = await createRepo(path.join(root, "leaf"));
    const middle = await createRepo(path.join(root, "middle"));
    git(middle, ["-c", "protocol.file.allow=always", "submodule", "add", leaf, "leaf"]);
    git(middle, ["commit", "-am", "Add leaf submodule"]);

    await client.connect();
    const created = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "built-in" },
    });
    expect(created.error).toBeNull();
    const checkout = created.workspace!.workspaceDirectory;
    await addNestedGitContent(checkout, leaf, middle);

    const archived = await client.archiveWorkspace(created.workspace!.id);
    expect(archived.error).toBeNull();
    await expect(stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(repository, ["worktree", "list", "--porcelain"])).not.toContain(
      "refs/heads/built-in",
    );
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

test("archive and rollback refuse to delete a worktree containing a live nested Git worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-worktree-nested-delete-guard-"));
  const repository = await createRepo(path.join(root, "repo"));
  const detachedCreatedMarker = path.join(root, "detached-created");
  const releaseDetachedMarker = path.join(root, "release-detached");
  const removeCallsFile = path.join(root, "remove-calls.log");

  const pluginDir = path.join(root, "nested-delete-guard-manager");
  await mkdir(pluginDir);
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "nested-delete-guard-manager", requirements: { paseo: ">=0.17.0" } }),
  );
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export default function contribute(server) {
  return server.registerWorktreeManager({
    async create(request) {
      const target = path.join(path.dirname(request.repoRoot), "managed-" + request.branch);
      if (request.branch === "detached-outer") {
        execFileSync("git", ["worktree", "add", "--detach", target, request.baseRef], {
          cwd: request.repoRoot,
          stdio: "pipe",
        });
        writeFileSync(${JSON.stringify(detachedCreatedMarker)}, target);
        const deadline = Date.now() + 15_000;
        while (!existsSync(${JSON.stringify(releaseDetachedMarker)})) {
          if (Date.now() > deadline) throw new Error("test did not release detached create");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { type: "created", path: target };
      }
      execFileSync("git", ["worktree", "add", "-b", request.branch, target, request.baseRef], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
      return { type: "created", path: target };
    },
    async remove(request) {
      appendFileSync(${JSON.stringify(removeCallsFile)}, request.path + "\\n");
      execFileSync("git", ["worktree", "remove", request.path, "--force"], {
        cwd: request.repoRoot,
        stdio: "pipe",
      });
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
    expect((await client.installDirectoryPlugin(pluginDir)).status).toBe("running");

    // 1. Archive of outer worktree must preserve a live nested Git worktree that Paseo does not track.
    const created = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "outer-archive" },
    });
    expect(created.error).toBeNull();
    const outerPath = created.workspace!.workspaceDirectory;
    const nestedArchivePath = path.join(outerPath, "untracked-nested");
    git(repository, ["worktree", "add", "-b", "untracked-nested", nestedArchivePath]);
    const nestedArchiveFile = path.join(nestedArchivePath, "uncommitted.txt");
    await writeFile(nestedArchiveFile, "keep-archive-nested");

    const archived = await client.archiveWorkspace(created.workspace!.id);
    expect(archived.error).toBeNull();
    expect(await readFile(nestedArchiveFile, "utf8")).toBe("keep-archive-nested");
    await expect(readFile(removeCallsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // 2. Rollback of a failed create must preserve a nested Git worktree added while create paused.
    const detachedCreate = client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "detached-outer" },
    });
    await expect
      .poll(
        () =>
          stat(detachedCreatedMarker).then(
            () => true,
            () => false,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    const detachedOuterPath = await readFile(detachedCreatedMarker, "utf8");
    const nestedRollbackPath = path.join(detachedOuterPath, "nested-during-create");
    git(repository, ["worktree", "add", "-b", "nested-during-create", nestedRollbackPath]);
    const nestedRollbackFile = path.join(nestedRollbackPath, "uncommitted.txt");
    await writeFile(nestedRollbackFile, "keep-rollback-nested");

    await writeFile(releaseDetachedMarker, "go");
    const detachedResult = await detachedCreate;
    expect(detachedResult.error).toContain("detached HEAD");
    expect(detachedResult.error).toContain("contains nested Git worktree");
    expect(await readFile(nestedRollbackFile, "utf8")).toBe("keep-rollback-nested");
    await expect(readFile(removeCallsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // 3. Archive of repo A's worktree must preserve a nested linked worktree belonging to another repo B.
    const otherRepo = await createRepo(path.join(root, "repo-b"));
    const crossRepoOuter = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "cross-repo-outer" },
    });
    expect(crossRepoOuter.error).toBeNull();
    const crossRepoOuterPath = crossRepoOuter.workspace!.workspaceDirectory;
    const otherRepoNestedPath = path.join(crossRepoOuterPath, "repo-b-nested");
    git(otherRepo, ["worktree", "add", "-b", "other-nested", otherRepoNestedPath]);
    const otherRepoDirtyFile = path.join(otherRepoNestedPath, "uncommitted.txt");
    await writeFile(otherRepoDirtyFile, "keep-repo-b");

    const crossRepoArchived = await client.archiveWorkspace(crossRepoOuter.workspace!.id);
    expect(crossRepoArchived.error).toBeNull();
    expect(await readFile(otherRepoDirtyFile, "utf8")).toBe("keep-repo-b");
    await expect(readFile(removeCallsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const middle = await createRepo(path.join(root, "middle"));
    git(middle, ["-c", "protocol.file.allow=always", "submodule", "add", otherRepo, "leaf"]);
    git(middle, ["commit", "-am", "Add leaf submodule"]);
    const managed = await client.createWorkspace({
      source: { kind: "worktree", cwd: repository, branchName: "nested-content" },
    });
    expect(managed.error).toBeNull();
    const checkout = managed.workspace!.workspaceDirectory;
    await addNestedGitContent(checkout, otherRepo, middle);

    const archivedWithContent = await client.archiveWorkspace(managed.workspace!.id);
    expect(archivedWithContent.error).toBeNull();
    expect(path.normalize((await readFile(removeCallsFile, "utf8")).trim())).toBe(
      path.normalize(checkout),
    );
    await expect(stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
