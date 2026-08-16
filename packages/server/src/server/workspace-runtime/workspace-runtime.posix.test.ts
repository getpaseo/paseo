import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createWorkspaceRuntimeService,
  type CreateWorkspaceInput,
  type WorkspaceRuntimeOptions,
  type WorkspaceRuntimeService,
} from "./index.js";
import { observeWorkspaceGit } from "../workspace-git-observation.js";

const cleanupRoots: string[] = [];
const posixDescribe = describe.runIf(process.platform !== "win32");
const runtimeContractIds = ["local", "worktree", "fixture"] as const;
const fixtureRuntimeExecutable = fileURLToPath(
  new URL("../../../../../runtimes/fixture/src/index.mjs", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("lists built-in and configured runtimes in registration order", async () => {
  const root = await temporaryRoot("catalog");
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "home"),
    externalRuntimes: {
      fixture: {
        type: "command",
        label: "Fixture",
        command: [process.execPath, fixtureRuntimeExecutable],
      },
    },
    resolveRuntimeId: async () => null,
    persistRuntimeId: async () => {},
  });

  expect(service.listRuntimes()).toEqual([
    { runtimeId: "local", builtin: true, requiresGitProject: false },
    { runtimeId: "worktree", builtin: true, requiresGitProject: true },
    {
      runtimeId: "fixture",
      builtin: false,
      label: "Fixture",
      requiresGitProject: true,
    },
  ]);
});

test("has no implicit command runtime registration in core", async () => {
  const root = await temporaryRoot("catalog-no-implicit-runtime");
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "home"),
    externalRuntimes: {
      fixture: {
        type: "command",
        label: "Fixture",
        command: [process.execPath, fixtureRuntimeExecutable],
      },
    },
    resolveRuntimeId: async () => null,
    persistRuntimeId: async () => {},
  });

  expect(service.listRuntimes()).toEqual([
    { runtimeId: "local", builtin: true, requiresGitProject: false },
    { runtimeId: "worktree", builtin: true, requiresGitProject: true },
    {
      runtimeId: "fixture",
      builtin: false,
      label: "Fixture",
      requiresGitProject: true,
    },
  ]);
  await expect(
    service.create({
      workspaceId: "unregistered-command-runtime",
      runtimeId: "docker",
      project: {
        id: "unregistered-command-runtime",
        source: { kind: "host-directory", path: root },
      },
      placement: { kind: "existing" },
    }),
  ).rejects.toThrow("Workspace runtime is not registered: docker");
});

posixDescribe("setup eligibility", () => {
  test("adopting an existing Local directory never executes its paseo.json setup", async () => {
    const fixture = await createFixture("local");
    const marker = path.join(fixture.repo, "local-adoption-setup-ran.txt");
    await writeFile(
      path.join(fixture.repo, "paseo.json"),
      JSON.stringify({
        worktree: { setup: ["printf setup > local-adoption-setup-ran.txt"] },
      }),
    );

    await expect(
      fixture.service.create({
        ...fixture.createInput,
      }),
    ).resolves.toMatchObject({ runtimeId: "local", cwd: fixture.repo });

    expect(existsSync(marker)).toBe(false);
    await fixture.service.destroy(fixture.workspaceId);
  });
});

posixDescribe("setup lifecycle environment", () => {
  test("supplies main's lifecycle variables only for setup execution", async () => {
    const fixture = await createFixture("worktree");
    await fixture.service.create(fixture.createInput);
    const runtime = await fixture.service.bind(fixture.workspaceId);
    const setup = await runtime.run({
      argv: [
        "/bin/sh",
        "-c",
        'printf \'%s\\n\' "$PASEO_SOURCE_CHECKOUT_PATH" "$PASEO_ROOT_PATH" "$PASEO_WORKTREE_PATH" "$PASEO_BRANCH_NAME" "$PASEO_WORKTREE_PORT"',
      ],
      env: {},
      purpose: { kind: "setup" },
    });
    setup.stdin.end();
    const output = (await collect(setup.stdout)).trim().split("\n");
    await expect(setup.exited).resolves.toEqual({ code: 0, signal: null });

    expect(await realpath(output[0]!)).toBe(await realpath(fixture.repo));
    expect(output[1]).toBe(output[0]);
    expect(await realpath(output[2]!)).toBe(await realpath(fixture.runtimeRoot()));
    expect(output[3]).toBeTruthy();
    expect(Number(output[4])).toBeGreaterThan(0);
    await fixture.service.destroy(fixture.workspaceId);
  });
});

posixDescribe("service lifecycle", () => {
  test("close releases runtime processes and observations without destroying backing", async () => {
    const fixture = await createFixture("worktree");
    await fixture.service.create(fixture.createInput);
    const runtime = await fixture.service.bind(fixture.workspaceId);
    const observation = await observeWorkspaceGit(runtime, () => undefined);
    const child = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      env: {},
      purpose: { kind: "workspace-script", script: "daemon-shutdown" },
    });
    child.stdin.end();

    await fixture.service.close();

    await expect(child.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(existsSync(fixture.runtimeRoot())).toBe(true);
    expect(fixture.runtimeIds.get(fixture.workspaceId)).toBe("worktree");
    await observation.unsubscribe();

    await createWorkspaceRuntimeService(fixture.options).destroy(fixture.workspaceId);
  });
});

posixDescribe.each(runtimeContractIds)("%s runtime public contract", (runtimeId) => {
  test("returns after materialization without waiting for configured setup", async () => {
    const fixture = await createFixture(runtimeId);
    await writeFile(
      path.join(fixture.repo, "paseo.json"),
      JSON.stringify({ worktree: { setup: ["while [ ! -f setup-release ]; do sleep 1; done"] } }),
    );

    const created = await fixture.service.create(fixture.createInput);

    expect(created.materializedFreshContent).toBe(runtimeId !== "local");
    expect(existsSync(path.join(fixture.runtimeRoot(), "setup-release"))).toBe(false);
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("creates a provider probe by adopting the project root without setup", async () => {
    const fixture = await createFixture(runtimeId);
    const setupMarker = path.join(fixture.repo, "probe-setup-ran.txt");

    const created = await fixture.service.create({
      ...fixture.createInput,
      placement: { kind: "existing" },
      purpose: "provider-probe",
      setup: [{ argv: ["/bin/sh", "-c", "printf setup > probe-setup-ran.txt"], env: {} }],
    });

    expect(await realpath(created.cwd)).toBe(await realpath(fixture.repo));
    expect(existsSync(setupMarker)).toBe(false);
    if (runtimeId === "worktree") {
      await expect(
        Promise.all(listLinkedWorktrees(fixture.repo).map((cwd) => realpath(cwd))),
      ).resolves.toEqual([await realpath(fixture.repo)]);
    }
    await fixture.service.destroy(fixture.workspaceId);
    expect(existsSync(fixture.repo)).toBe(true);
  });

  test("bound runtime exposes only process, file, and command-resolution primitives", async () => {
    const fixture = await createFixture(runtimeId);
    await fixture.service.create(fixture.createInput);

    const runtime = await fixture.service.bind(fixture.workspaceId);

    expect(Object.keys(runtime).sort()).toEqual([
      "files",
      "provider",
      "resolveCommand",
      "run",
      "scriptTerminal",
    ]);
    await expect(runtime.resolveCommand("git")).resolves.toMatch(/^\//u);
    await expect(runtime.resolveCommand("paseo-command-that-does-not-exist")).resolves.toBeNull();
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("binds streaming files and live observation to the selected runtime", async () => {
    const fixture = await createFixture(runtimeId);
    await fixture.service.create(fixture.createInput);
    const files = fixture.service.files(fixture.workspaceId);

    const listing = await files.list(".");
    expect(listing.entries.map((entry) => entry.name)).toContain("committed.txt");
    const initial = await files.stat("committed.txt");
    expect(initial).toMatchObject({ status: "ready", size: 10 });
    if (initial.status !== "ready") throw new Error("Expected committed.txt to exist");

    let resolveChanged!: () => void;
    const watcherEvents: Array<{ type: string; error?: string }> = [];
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const subscription = await files.subscribe({ paths: ["committed.txt"] }, (event) => {
      watcherEvents.push(event);
      if (event.type === "changed" && event.paths.includes("committed.txt")) resolveChanged();
    });
    const terminalEdit = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sh", "-c", "printf changed > committed.txt"],
      env: {},
      purpose: { kind: "terminal", terminalId: `${runtimeId}-file-edit` },
    });
    terminalEdit.stdin.end();
    await expect(terminalEdit.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(changed).resolves.toBeUndefined();

    const streamed = await files.read("committed.txt");
    await expect(collect(streamed.chunks)).resolves.toBe("changed");
    await fixture.service.pause(fixture.workspaceId);
    expect(watcherEvents).toContainEqual({
      type: "error",
      error: "Workspace files client is closed",
    });
    await expect(files.list(".")).rejects.toThrow(`Workspace runtime is paused`);
    await subscription.unsubscribe();
    await fixture.service.resume(fixture.workspaceId);
    await expect(files.list(".")).resolves.toMatchObject({ path: "." });
    const reconstructedEvents: Array<{ type: string; error?: string }> = [];
    await files.subscribe({ paths: ["committed.txt"] }, (event) => {
      reconstructedEvents.push(event);
    });
    await fixture.service.destroy(fixture.workspaceId);
    expect(reconstructedEvents).toContainEqual({
      type: "error",
      error: "Workspace files client is closed",
    });
  });

  test("opens an interactive PTY with input, Unicode output, resize, EOF, and signals", async () => {
    const fixture = await createFixture(runtimeId);
    await fixture.service.create(fixture.createInput);

    const terminal = await fixture.service.openTerminal({
      workspaceId: fixture.workspaceId,
      argv: [
        process.execPath,
        "-e",
        "process.stdin.setEncoding('utf8');process.stdout.write(`${process.cwd()}|${process.stdout.isTTY}|${process.stdout.columns}x${process.stdout.rows}|λ`);process.stdin.once('data',data=>{const finish=()=>{process.stdout.write(`|${data.trim()}|${process.stdout.columns}x${process.stdout.rows}`);process.exit(7)};process.stdout.columns===101?finish():process.stdout.once('resize',finish)})",
      ],
      env: { PATH: process.env.PATH ?? "" },
      purpose: { kind: "terminal", terminalId: `${runtimeId}-terminal` },
      rows: 24,
      cols: 80,
      term: "xterm-256color",
    });
    const output = collectTerminal(terminal);
    await waitForTerminalOutput(output, "|true|80x24|λ");
    terminal.resize(101, 37);
    terminal.write("héllo\n");
    await expect(terminal.exited).resolves.toEqual({ code: 7, signal: null });
    expect(output.value()).toContain("|héllo|101x37");

    const signaled = await fixture.service.openTerminal({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sleep", "30"],
      env: { PATH: "/usr/bin:/bin" },
      purpose: { kind: "terminal", terminalId: `${runtimeId}-signal-terminal` },
      rows: 24,
      cols: 80,
    });
    signaled.kill("SIGTERM");
    await expect(signaled.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });

    const forced = await fixture.service.openTerminal({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sleep", "30"],
      env: { PATH: "/usr/bin:/bin" },
      purpose: { kind: "terminal", terminalId: `${runtimeId}-force-terminal` },
      rows: 24,
      cols: 80,
    });
    forced.kill("SIGKILL");
    await expect(forced.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });

    await fixture.service.destroy(fixture.workspaceId);
  });

  test("creates, pipes an exact environment, preserves status, and owns only its resources", async () => {
    const fixture = await createFixture(runtimeId);
    const created = await fixture.service.create(fixture.createInput);
    const compatibilityCwd =
      runtimeId === "worktree" ? await realpath(fixture.runtimeRoot()) : fixture.runtimeRoot();
    expect(created).toEqual({
      workspaceId: fixture.workspaceId,
      runtimeId,
      cwd: compatibilityCwd,
      ...(runtimeId === "fixture" ? {} : { hostVisiblePath: compatibilityCwd }),
      materializedFreshContent: runtimeId !== "local",
    });
    await expect(fixture.service.inspect(fixture.workspaceId)).resolves.toEqual({
      status: "ready",
      cwd: compatibilityCwd,
      ...(runtimeId === "fixture" ? {} : { hostVisiblePath: compatibilityCwd }),
    });
    if (runtimeId === "fixture") {
      await expect(fixture.service.requireHostVisiblePath(fixture.workspaceId)).rejects.toThrow(
        `Workspace has no host-visible path: ${fixture.workspaceId}`,
      );
    } else {
      await expect(fixture.service.requireHostVisiblePath(fixture.workspaceId)).resolves.toBe(
        compatibilityCwd,
      );
    }

    const runtimeRoot = fixture.runtimeRoot();
    expect(await readFile(path.join(runtimeRoot, "committed.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(path.join(runtimeRoot, "setup-owned.txt"))).toBe(false);

    const child = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: [
        "/bin/sh",
        "-c",
        "cat > runtime-owned.txt; printf runtime-stdout; printf runtime-stderr >&2; exit 23",
      ],
      env: { RUNTIME_EXACT_ENV: runtimeId },
      purpose: { kind: "workspace-script", script: "public-contract" },
    });
    child.stdin.end(`${runtimeId}-state`);
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.exited,
    ]);
    expect({ stdout, stderr, exit }).toEqual({
      stdout: "runtime-stdout",
      stderr: "runtime-stderr",
      exit: { code: 23, signal: null },
    });

    const env = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/usr/bin/env"],
      env: { RUNTIME_EXACT_ENV: runtimeId },
      purpose: { kind: "workspace-script", script: "environment-contract" },
    });
    env.stdin.end();
    await expect(collect(env.stdout)).resolves.toBe(`RUNTIME_EXACT_ENV=${runtimeId}\n`);
    await expect(env.exited).resolves.toEqual({ code: 0, signal: null });

    const signaled = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sleep", "30"],
      env: {},
      purpose: { kind: "workspace-script", script: "signal-contract" },
    });
    signaled.stdin.end();
    signaled.kill("SIGTERM");
    await expect(signaled.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });

    await fixture.service.pause(fixture.workspaceId);
    const recovered = createWorkspaceRuntimeService(fixture.options);
    await expect(
      recovered.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "paused-contract" },
      }),
    ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
    await recovered.resume(fixture.workspaceId);
    expect(await readFile(path.join(runtimeRoot, "runtime-owned.txt"), "utf8")).toBe(
      `${runtimeId}-state`,
    );

    await recovered.destroy(fixture.workspaceId);
    expect(existsSync(fixture.repo)).toBe(true);
    expect(existsSync(runtimeRoot)).toBe(runtimeId !== "worktree");
    await expect(
      recovered.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "missing-contract" },
      }),
    ).rejects.toThrow(`Workspace runtime is not selected: ${fixture.workspaceId}`);
  });

  test("repeated create preserves setup eligibility and paused state", async () => {
    const fixture = await createFixture(runtimeId);
    const setupMarker = "idempotent-setup.txt";
    const input = {
      ...fixture.createInput,
      setup: [
        {
          argv: ["/bin/sh", "-c", `printf 'setup\\n' >> ${setupMarker}`] as const,
          env: {},
        },
      ],
    };
    await fixture.service.create(input);
    await fixture.service.pause(fixture.workspaceId);
    await fixture.service.create(input);
    expect(existsSync(path.join(fixture.runtimeRoot(), setupMarker))).toBe(false);
    await expect(
      fixture.service.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "idempotence-contract" },
      }),
    ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
    await fixture.service.resume(fixture.workspaceId);
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("archive, restore, reconstruction, and permanent deletion converge", async () => {
    const fixture = await createFixture(runtimeId, { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    const runtimeRoot = fixture.runtimeRoot();
    await writeFile(path.join(runtimeRoot, "dirty-untracked.txt"), "preserved\n");
    let resolveRestoredChange!: (paths: string[]) => void;
    const restoredChange = new Promise<string[]>((resolve) => {
      resolveRestoredChange = resolve;
    });
    const subscription = await fixture.service
      .files(fixture.workspaceId)
      .subscribe({ paths: ["dirty-untracked.txt"] }, (event) => {
        if (event.type === "changed") resolveRestoredChange(event.paths);
      });

    await Promise.all([
      fixture.service.archive(fixture.workspaceId, { releaseBacking: true }),
      fixture.service.archive(fixture.workspaceId, { releaseBacking: true }),
    ]);
    expect(fixture.archivedWorkspaceIds.has(fixture.workspaceId)).toBe(true);
    if (runtimeId === "worktree") {
      expect(existsSync(runtimeRoot)).toBe(false);
    }
    await expect(fixture.service.inspect(fixture.workspaceId)).resolves.toMatchObject({
      status: "paused",
    });

    await Promise.all([
      fixture.service.restore(fixture.workspaceId),
      fixture.service.restore(fixture.workspaceId),
    ]);
    expect(fixture.archivedWorkspaceIds.has(fixture.workspaceId)).toBe(false);
    expect(existsSync(runtimeRoot)).toBe(true);
    await writeFile(path.join(runtimeRoot, "dirty-untracked.txt"), "observed\n");
    await expect(restoredChange).resolves.toEqual(["dirty-untracked.txt"]);
    await subscription.unsubscribe();

    await fixture.service.archive(fixture.workspaceId);
    const reconstructed = createWorkspaceRuntimeService(fixture.options);
    await expect(
      reconstructed.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "archived-admission" },
      }),
    ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
    await Promise.all([
      reconstructed.restore(fixture.workspaceId),
      reconstructed.restore(fixture.workspaceId),
    ]);
    expect(fixture.archivedWorkspaceIds.has(fixture.workspaceId)).toBe(false);
    if (runtimeId !== "worktree") {
      expect(await readFile(path.join(runtimeRoot, "dirty-untracked.txt"), "utf8")).toBe(
        "observed\n",
      );
    }

    await Promise.all([
      reconstructed.destroy(fixture.workspaceId),
      reconstructed.destroy(fixture.workspaceId),
    ]);
    expect(fixture.runtimeIds.has(fixture.workspaceId)).toBe(false);
    expect(existsSync(fixture.repo)).toBe(true);
    expect(existsSync(runtimeRoot)).toBe(runtimeId !== "worktree");
  });

  test("registry failures leave lifecycle transitions retryable without opening an admission gap", async () => {
    const fixture = await createFixture(runtimeId, { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    fixture.lifecycleFailures.archive = 1;
    await expect(fixture.service.archive(fixture.workspaceId)).rejects.toThrow(
      "archive persistence failed",
    );
    await expect(
      fixture.service.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "failed-archive-barrier" },
      }),
    ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
    await fixture.service.archive(fixture.workspaceId);

    fixture.lifecycleFailures.restore = 1;
    await expect(fixture.service.restore(fixture.workspaceId)).rejects.toThrow(
      "restore persistence failed",
    );
    await expect(
      fixture.service.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "failed-restore-barrier" },
      }),
    ).rejects.toThrow(`Workspace runtime is recovering: ${fixture.workspaceId}`);
    await fixture.service.restore(fixture.workspaceId);
    const admitted = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/usr/bin/true"],
      env: {},
      purpose: { kind: "workspace-script", script: "restored-admission" },
    });
    admitted.stdin.end();
    await expect(admitted.exited).resolves.toEqual({ code: 0, signal: null });
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("permanent deletion survives intent and final-record persistence failures", async () => {
    const fixture = await createFixture(runtimeId, { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    const runtimeRoot = fixture.runtimeRoot();
    await writeFile(path.join(runtimeRoot, "adopted-state.txt"), "keep local data\n");

    fixture.lifecycleFailures.beginDelete = 1;
    await expect(fixture.service.destroy(fixture.workspaceId)).rejects.toThrow(
      "delete intent persistence failed",
    );
    expect(existsSync(runtimeRoot)).toBe(true);
    const usable = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/usr/bin/true"],
      env: {},
      purpose: { kind: "workspace-script", script: "failed-delete-intent" },
    });
    usable.stdin.end();
    await expect(usable.exited).resolves.toEqual({ code: 0, signal: null });

    fixture.lifecycleFailures.remove = 1;
    await expect(fixture.service.destroy(fixture.workspaceId)).rejects.toThrow(
      "record removal persistence failed",
    );
    expect(fixture.deletingWorkspaceIds.has(fixture.workspaceId)).toBe(true);
    expect(fixture.runtimeIds.has(fixture.workspaceId)).toBe(true);
    expect(existsSync(runtimeRoot)).toBe(runtimeId !== "worktree");

    const reconstructed = createWorkspaceRuntimeService(fixture.options);
    await reconstructed.reconcile();
    await reconstructed.destroy(fixture.workspaceId);
    expect(fixture.runtimeIds.has(fixture.workspaceId)).toBe(false);
    expect(existsSync(fixture.repo)).toBe(true);
    if (runtimeId !== "worktree") {
      await expect(readFile(path.join(runtimeRoot, "adopted-state.txt"), "utf8")).resolves.toBe(
        "keep local data\n",
      );
    }
  });

  test("startup reconciliation converges interrupted archive and restore transitions", async () => {
    const fixture = await createFixture(runtimeId, { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    await fixture.service.pause(fixture.workspaceId);

    const reconstructed = createWorkspaceRuntimeService(fixture.options);
    await reconstructed.reconcile();
    const resumed = await reconstructed.run({
      workspaceId: fixture.workspaceId,
      argv: ["/usr/bin/true"],
      env: {},
      purpose: { kind: "workspace-script", script: "reconciled-resume" },
    });
    resumed.stdin.end();
    await expect(resumed.exited).resolves.toEqual({ code: 0, signal: null });

    await reconstructed.archive(fixture.workspaceId);
    await reconstructed.resume(fixture.workspaceId);
    const afterInterruptedRestore = createWorkspaceRuntimeService(fixture.options);
    await afterInterruptedRestore.reconcile();
    await expect(
      afterInterruptedRestore.run({
        workspaceId: fixture.workspaceId,
        argv: ["/usr/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "reconciled-archive" },
      }),
    ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
    await afterInterruptedRestore.destroy(fixture.workspaceId);
  });

  test("archive hooks execute inside the selected runtime exactly once", async () => {
    const fixture = await createFixture(runtimeId, { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    const configure = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync("paseo.json", ${JSON.stringify(
          JSON.stringify({
            worktree: { teardown: ["printf archived >> archive-hook.txt"] },
          }),
        )})`,
      ],
      env: {},
      purpose: { kind: "setup" },
    });
    configure.stdin.end();
    await expect(configure.exited).resolves.toEqual({ code: 0, signal: null });

    await fixture.service.archive(fixture.workspaceId);
    await fixture.service.archive(fixture.workspaceId);
    expect(await readFile(path.join(fixture.runtimeRoot(), "archive-hook.txt"), "utf8")).toBe(
      "archived",
    );
    await fixture.service.restore(fixture.workspaceId);
    await fixture.service.destroy(fixture.workspaceId);
  });
});

posixDescribe("worktree exact restore", () => {
  test("rejects a preserved worktree whose branch changed", async () => {
    const fixture = await createFixture("worktree", { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    const runtimeRoot = fixture.runtimeRoot();
    await fixture.service.archive(fixture.workspaceId);
    execFileSync("git", ["switch", "-c", "unexpected-branch"], {
      cwd: runtimeRoot,
      stdio: "pipe",
    });

    await expect(fixture.service.restore(fixture.workspaceId)).rejects.toThrow(
      "Workspace runtime worktree branch changed: expected runtime-branch, received unexpected-branch",
    );

    execFileSync("git", ["switch", "runtime-branch"], { cwd: runtimeRoot, stdio: "pipe" });
    await fixture.service.restore(fixture.workspaceId);
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("rejects a selected subdirectory replaced by an escaping symlink", async () => {
    const fixture = await createFixture("worktree", { lifecycleRecords: true });
    await mkdir(path.join(fixture.repo, "nested"));
    await writeFile(path.join(fixture.repo, "nested", "file.txt"), "nested\n");
    execFileSync("git", ["add", "."], { cwd: fixture.repo, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add nested"], {
      cwd: fixture.repo,
      stdio: "pipe",
    });
    await fixture.service.create({
      ...fixture.createInput,
      placement: {
        ...(fixture.createInput.placement as Extract<
          CreateWorkspaceInput["placement"],
          { kind: "branch" }
        >),
        relativeCwd: "nested",
      },
    });
    const runtimeRoot = fixture.runtimeRoot();
    await fixture.service.archive(fixture.workspaceId);
    await rm(path.join(runtimeRoot, "nested"), { recursive: true });
    await symlink(fixture.root, path.join(runtimeRoot, "nested"));

    await expect(fixture.service.restore(fixture.workspaceId)).rejects.toThrow();
    expect(await realpath(path.join(runtimeRoot, "nested"))).toBe(await realpath(fixture.root));
  });

  test("fails closed when the saved path is occupied", async () => {
    const fixture = await createFixture("worktree", { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    const runtimeRoot = fixture.runtimeRoot();
    await fixture.service.archive(fixture.workspaceId, { releaseBacking: true });
    await mkdir(runtimeRoot, { recursive: true });

    await expect(fixture.service.restore(fixture.workspaceId)).rejects.toThrow(
      `Workspace runtime worktree path is occupied: ${runtimeRoot}`,
    );
    expect(listLinkedWorktrees(fixture.repo)).not.toContain(runtimeRoot);

    await rm(runtimeRoot, { recursive: true, force: true });
    await fixture.service.restore(fixture.workspaceId);
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("reports a missing source repository before attempting rematerialization", async () => {
    const fixture = await createFixture("worktree", { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    await fixture.service.archive(fixture.workspaceId, { releaseBacking: true });
    const displacedRepo = `${fixture.repo}-missing`;
    await rename(fixture.repo, displacedRepo);

    await expect(fixture.service.restore(fixture.workspaceId)).rejects.toThrow(
      "The source repository needed to restore this worktree no longer exists.",
    );

    await rename(displacedRepo, fixture.repo);
    await fixture.service.restore(fixture.workspaceId);
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("fails closed when the saved branch is checked out elsewhere", async () => {
    const fixture = await createFixture("worktree", { lifecycleRecords: true });
    await fixture.service.create(fixture.createInput);
    const runtimeRoot = fixture.runtimeRoot();
    await fixture.service.archive(fixture.workspaceId, { releaseBacking: true });
    const otherRoot = path.join(fixture.root, "branch-owner");
    execFileSync("git", ["worktree", "add", otherRoot, "runtime-branch"], {
      cwd: fixture.repo,
      stdio: "pipe",
    });

    await expect(fixture.service.restore(fixture.workspaceId)).rejects.toThrow();
    expect(existsSync(runtimeRoot)).toBe(false);

    execFileSync("git", ["worktree", "remove", "--force", otherRoot], {
      cwd: fixture.repo,
      stdio: "pipe",
    });
    await fixture.service.restore(fixture.workspaceId);
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("removes a partial restore when the selected subdirectory is missing", async () => {
    const fixture = await createFixture("worktree", { lifecycleRecords: true });
    await mkdir(path.join(fixture.repo, "nested"));
    await writeFile(path.join(fixture.repo, "nested", "file.txt"), "nested\n");
    execFileSync("git", ["add", "."], { cwd: fixture.repo, stdio: "pipe" });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add nested"], {
      cwd: fixture.repo,
      stdio: "pipe",
    });
    const createInput: CreateWorkspaceInput = {
      ...fixture.createInput,
      placement: {
        ...(fixture.createInput.placement as Extract<
          CreateWorkspaceInput["placement"],
          { kind: "branch" }
        >),
        relativeCwd: "nested",
      },
    };
    await fixture.service.create(createInput);
    const runtimeRoot = fixture.runtimeRoot();
    await fixture.service.archive(fixture.workspaceId, { releaseBacking: true });
    execFileSync("git", ["branch", "-f", "runtime-branch", "main~1"], {
      cwd: fixture.repo,
      stdio: "pipe",
    });

    await expect(fixture.service.restore(fixture.workspaceId)).rejects.toThrow(
      "Selected project directory is missing from the worktree",
    );
    expect(existsSync(runtimeRoot)).toBe(false);
  });
});

posixDescribe("reconstruction placement recovery", () => {
  test("refreshes persisted compatibility cwd from driver inspect", async () => {
    const root = await temporaryRoot("reconcile-compatibility-cwd");
    const repo = await createRepository(root);
    const runtimeIds = new Map<string, string>();
    const placements = new Map<string, { cwd: string; hostVisiblePath?: string }>();
    const options: WorkspaceRuntimeOptions = {
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId, placement) => {
        runtimeIds.set(workspaceId, runtimeId);
        placements.set(workspaceId, placement);
      },
      beginWorkspaceDeletion: async () => {},
      removeWorkspaceRecord: async (workspaceId) => {
        runtimeIds.delete(workspaceId);
        placements.delete(workspaceId);
      },
      listRuntimeRecords: async () => [
        { workspaceId: "recover-cwd", runtimeId: "local", archived: false },
      ],
    };
    const service = createWorkspaceRuntimeService(options);
    await service.create({
      workspaceId: "recover-cwd",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: repo } },
      placement: { kind: "existing" },
    });
    placements.set("recover-cwd", { cwd: "/stale/presentation/path" });

    await createWorkspaceRuntimeService(options).reconcile();

    expect(placements.get("recover-cwd")).toEqual({ cwd: repo, hostVisiblePath: repo });
    await service.destroy("recover-cwd");
  });
});

posixDescribe("fail-closed and producer cleanup", () => {
  test("missing and unregistered selections never fall back to the host", async () => {
    const root = await temporaryRoot("fail-closed");
    const runtimeIds = new Map<string, string>();
    const service = createService(root, runtimeIds);
    await expect(
      service.run({
        workspaceId: "missing",
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "missing-selection" },
      }),
    ).rejects.toThrow("Workspace runtime is not selected: missing");
    runtimeIds.set("missing", "not-registered");
    await expect(
      service.run({
        workspaceId: "missing",
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "unregistered-selection" },
      }),
    ).rejects.toThrow("Workspace runtime is not registered: not-registered");
    await expect(
      service.create({
        workspaceId: "unknown",
        runtimeId: "not-registered",
        project: { id: "project", source: { kind: "host-directory", path: root } },
        placement: { kind: "existing" },
      }),
    ).rejects.toThrow("Workspace runtime is not registered: not-registered");
  });

  test("persistence failure destroys the newly-created worktree", async () => {
    const root = await temporaryRoot("persist-cleanup");
    const repo = await createRepository(root);
    const worktreesRoot = path.join(root, "worktrees");
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      worktreesRoot,
      resolveRuntimeId: async () => null,
      persistRuntimeId: async () => {
        throw new Error("persistence failed");
      },
    });
    await expect(
      service.create({
        workspaceId: "../../hostile-id",
        runtimeId: "worktree",
        project: { id: "project", source: { kind: "host-directory", path: repo } },
        placement: {
          kind: "branch",
          branchName: "persist-cleanup",
          baseRef: "main",
          worktreeSlug: "persist-cleanup",
        },
      }),
    ).rejects.toThrow("persistence failed");
    expect(listLinkedWorktrees(repo)).toHaveLength(1);
    expect(existsSync(path.join(root, "hostile-id.json"))).toBe(false);
  });

  test("persistence failure removes newly-created local driver state", async () => {
    const root = await temporaryRoot("local-persist-cleanup");
    const repo = await createRepository(root);
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async () => null,
      persistRuntimeId: async () => {
        throw new Error("persistence failed");
      },
    });
    await expect(
      service.create({
        workspaceId: "../../hostile-local-id",
        runtimeId: "local",
        project: { id: "project", source: { kind: "host-directory", path: repo } },
        placement: { kind: "existing" },
      }),
    ).rejects.toThrow("persistence failed");
    await expect(
      service.run({
        workspaceId: "../../hostile-local-id",
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "cleanup-contract" },
      }),
    ).rejects.toThrow("Workspace runtime is not selected");
    expect(existsSync(path.join(root, "hostile-local-id.json"))).toBe(false);
  });
});

posixDescribe.each(runtimeContractIds)(
  "%s runtime confinement and process teardown",
  (runtimeId) => {
    test("rejects a symlink cwd that resolves outside the runtime root", async () => {
      const fixture = await createFixture(runtimeId);
      await fixture.service.create(fixture.createInput);
      const outside = path.join(fixture.root, "outside");
      await mkdir(outside);
      await symlink(outside, path.join(fixture.runtimeRoot(), "escape"));
      const attempt = fixture.service.run({
        workspaceId: fixture.workspaceId,
        cwd: "escape",
        argv: ["/bin/pwd"],
        env: {},
        purpose: { kind: "workspace-script", script: "cwd-contract" },
      });
      if (runtimeId === "fixture") {
        const process = await attempt;
        process.stdin.end();
        const stderr = collect(process.stderr);
        await expect(process.exited).rejects.toThrow("Workspace cwd escapes its runtime root");
        await expect(stderr).resolves.toContain("Workspace cwd escapes its runtime root");
      } else {
        await expect(attempt).rejects.toThrow("Workspace cwd escapes its runtime root");
      }
      await fixture.service.destroy(fixture.workspaceId);
    });

    test("pause escalates past ignored SIGTERM and leaves no descendant", async () => {
      const fixture = await createFixture(runtimeId);
      await fixture.service.create(fixture.createInput);
      const child = await fixture.service.run({
        workspaceId: fixture.workspaceId,
        argv: [
          process.execPath,
          "-e",
          "process.on('SIGTERM',()=>{});const c=require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});require('fs').writeFileSync('descendant.pid',String(c.pid));setInterval(()=>{},1000)",
        ],
        env: {},
        purpose: { kind: "workspace-script", script: "teardown-contract" },
      });
      child.stdin.end();
      const pidFile = path.join(fixture.runtimeRoot(), "descendant.pid");
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const descendantPid = Number((await readFile(pidFile, "utf8")).trim());
      const startedAt = Date.now();
      await fixture.service.pause(fixture.workspaceId);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      await expect(child.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
      await vi.waitFor(() => expect(isProcessAlive(descendantPid)).toBe(false));
      await fixture.service.resume(fixture.workspaceId);
      await fixture.service.destroy(fixture.workspaceId);
    });
  },
);

async function createFixture(
  runtimeId: "local" | "worktree" | "fixture",
  fixtureOptions: { lifecycleRecords?: boolean } = {},
) {
  const root = await temporaryRoot(runtimeId);
  const repo = await createRepository(root);
  const runtimeIds = new Map<string, string>();
  const archivedWorkspaceIds = new Set<string>();
  const deletingWorkspaceIds = new Set<string>();
  const lifecycleFailures = { archive: 0, restore: 0, beginDelete: 0, remove: 0 };
  const worktreesRoot = path.join(root, "worktrees");
  const fixtureStateDirectory = path.join(root, "fixture-state");
  await mkdir(fixtureStateDirectory);
  const options: WorkspaceRuntimeOptions = {
    paseoHome: path.join(root, "home"),
    worktreesRoot,
    externalRuntimes:
      runtimeId === "fixture"
        ? {
            fixture: {
              type: "command",
              command: [process.execPath, fixtureRuntimeExecutable],
              options: { stateDirectory: fixtureStateDirectory },
            },
          }
        : undefined,
    resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
    persistRuntimeId: async (workspaceId, selectedRuntimeId) => {
      runtimeIds.set(workspaceId, selectedRuntimeId);
    },
    beginWorkspaceDeletion: async (workspaceId) => {
      if (lifecycleFailures.beginDelete > 0) {
        lifecycleFailures.beginDelete -= 1;
        throw new Error("delete intent persistence failed");
      }
      deletingWorkspaceIds.add(workspaceId);
    },
    removeWorkspaceRecord: async (workspaceId) => {
      if (lifecycleFailures.remove > 0) {
        lifecycleFailures.remove -= 1;
        throw new Error("record removal persistence failed");
      }
      runtimeIds.delete(workspaceId);
      archivedWorkspaceIds.delete(workspaceId);
      deletingWorkspaceIds.delete(workspaceId);
    },
    ...(fixtureOptions.lifecycleRecords
      ? {
          archiveWorkspaceRecord: async (workspaceId: string) => {
            if (lifecycleFailures.archive > 0) {
              lifecycleFailures.archive -= 1;
              throw new Error("archive persistence failed");
            }
            archivedWorkspaceIds.add(workspaceId);
          },
          restoreWorkspaceRecord: async (workspaceId: string) => {
            if (lifecycleFailures.restore > 0) {
              lifecycleFailures.restore -= 1;
              throw new Error("restore persistence failed");
            }
            archivedWorkspaceIds.delete(workspaceId);
          },
          listRuntimeRecords: async () =>
            [...runtimeIds].map(([workspaceId, selectedRuntimeId]) => ({
              workspaceId,
              runtimeId: selectedRuntimeId,
              archived: archivedWorkspaceIds.has(workspaceId),
              deleting: deletingWorkspaceIds.has(workspaceId),
            })),
        }
      : {}),
  };
  const workspaceId = `${runtimeId}-workspace`;
  const createInput: CreateWorkspaceInput = {
    workspaceId,
    runtimeId,
    project: { id: `${runtimeId}-project`, source: { kind: "host-directory", path: repo } },
    placement:
      runtimeId !== "worktree"
        ? { kind: "existing" }
        : {
            kind: "branch",
            branchName: "runtime-branch",
            baseRef: "main",
            worktreeSlug: "runtime-worktree",
          },
    setup:
      runtimeId === "worktree"
        ? [{ argv: ["/bin/sh", "-c", "printf 'setup\\n' > setup-owned.txt"], env: {} }]
        : undefined,
  };
  return {
    root,
    repo,
    options,
    runtimeIds,
    archivedWorkspaceIds,
    deletingWorkspaceIds,
    lifecycleFailures,
    workspaceId,
    createInput,
    service: createWorkspaceRuntimeService(options),
    runtimeRoot: () =>
      runtimeId !== "worktree"
        ? repo
        : listLinkedWorktrees(repo).find((cwd) => path.basename(cwd) === "runtime-worktree")!,
  };
}

function createService(root: string, runtimeIds: Map<string, string>): WorkspaceRuntimeService {
  return createWorkspaceRuntimeService({
    paseoHome: path.join(root, "home"),
    resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
    persistRuntimeId: async (workspaceId, runtimeId) => {
      runtimeIds.set(workspaceId, runtimeId);
    },
  });
}

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `paseo-runtime-${name}-`));
  cleanupRoots.push(root);
  return root;
}

async function createRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
  await writeFile(path.join(repo, "committed.txt"), "committed\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

function listLinkedWorktrees(repo: string): string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function collectTerminal(terminal: { onData(listener: (data: string) => void): () => void }): {
  value(): string;
} {
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  return { value: () => output };
}

async function waitForTerminalOutput(output: { value(): string }, marker: string): Promise<void> {
  await vi.waitFor(() => expect(output.value()).toContain(marker));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
