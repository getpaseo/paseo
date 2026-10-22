#!/usr/bin/env npx tsx

/**
 * A terminal worker survives an upgrade of the installation that started it. Two disposable
 * installations A and B (built dist, real copies of @getpaseo/server, @getpaseo/cli and
 * node-pty, every other dependency a symlink into this repo) each get their own CLI shim, so
 * each daemon's PASEO_CLI is a distinct path:
 *
 * 1. A daemon from A runs its worker from a copy in $PASEO_HOME/terminal-worker/. After
 *    `stop --keep-terminals` and moving A's node-pty, worker bundle and shell integration away,
 *    a daemon from B adopts the same worker and opens a new, working terminal in it with B's
 *    environment and CLI, while the first terminal keeps A's.
 * 2. Worker protocol versions (PASEO_TERMINAL_WORKER_PROTOCOL_OVERRIDE): a worker one version
 *    old drains (keeps its terminal, new ones open in a second worker, it exits after its last
 *    terminal and its copy is deleted); one two versions old is shut down; one from a newer
 *    Paseo is left running, reported as terminal_worker_incompatible, and closed by
 *    `daemon stop`.
 *
 * Every process it starts is stopped in `finally`.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAvailablePort } from "./helpers/network.ts";

if (process.platform === "win32") {
  console.log("Skipping terminal worker upgrade CLI test on Windows (POSIX shell terminals).");
  process.exit(0);
}

console.log("=== Terminal worker survives an upgrade ===\n");

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const root = await mkdtemp(join(tmpdir(), "paseo-worker-upgrade-"));
const paseoHome = join(root, "home");
const cliHome = join(root, "os-home");
const workDir = join(root, "work");
for (const dir of [paseoHome, cliHome, workDir]) mkdirSync(dir, { recursive: true });
const port = await getAvailablePort();
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find((candidate) => existsSync(candidate)) ?? null;

interface Installation {
  name: string;
  dir: string;
  version: string;
  shim: string;
  serverDir: string;
}

// ---------------------------------------------------------------------------------------------
// Installation fixtures
// ---------------------------------------------------------------------------------------------

function linkEntries(source: string, target: string, taken: Set<string>): void {
  if (!existsSync(source)) return;
  for (const name of readdirSync(source)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      mkdirSync(join(target, name), { recursive: true });
      for (const scoped of readdirSync(join(source, name))) {
        const key = `${name}/${scoped}`;
        if (taken.has(key)) continue;
        taken.add(key);
        symlinkSync(join(source, name, scoped), join(target, name, scoped));
      }
      continue;
    }
    if (taken.has(name)) continue;
    taken.add(name);
    symlinkSync(join(source, name), join(target, name));
  }
}

function createInstallation(name: string, version: string): Installation {
  const dir = join(root, `install-${name}`);
  const modules = join(dir, "node_modules");
  mkdirSync(join(modules, "@getpaseo"), { recursive: true });

  // Real copies: the server (its version marks the installation), the CLI (so it resolves this
  // installation's server), and node-pty (so moving it away breaks only this installation).
  const serverDir = join(modules, "@getpaseo", "server");
  const serverPackage = JSON.parse(
    readFileSync(join(repoRoot, "packages/server/package.json"), "utf8"),
  ) as Record<string, unknown>;
  mkdirSync(join(serverDir, "dist"), { recursive: true });
  writeFileSync(
    join(serverDir, "package.json"),
    `${JSON.stringify({ ...serverPackage, version }, null, 2)}\n`,
  );
  for (const part of ["server", "src", "scripts"]) {
    cpSync(join(repoRoot, "packages/server/dist", part), join(serverDir, "dist", part), {
      recursive: true,
    });
  }
  const cliDir = join(modules, "@getpaseo", "cli");
  mkdirSync(cliDir, { recursive: true });
  cpSync(join(repoRoot, "packages/cli/package.json"), join(cliDir, "package.json"));
  cpSync(join(repoRoot, "packages/cli/dist"), join(cliDir, "dist"), { recursive: true });
  cpSync(join(repoRoot, "packages/server/node_modules/node-pty"), join(modules, "node-pty"), {
    recursive: true,
  });

  const taken = new Set(["@getpaseo/server", "@getpaseo/cli", "node-pty"]);
  for (const source of [
    "packages/server/node_modules",
    "packages/cli/node_modules",
    "node_modules",
  ]) {
    linkEntries(join(repoRoot, source), modules, taken);
  }

  const shim = join(dir, "bin", "paseo");
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${join(cliDir, "dist", "index.js")}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return { name, dir, version, shim, serverDir };
}

// The runtime files an upgrade replaces: node-pty, the worker bundle, the shell integration.
function moveRuntimeAway(installation: Installation): () => void {
  const away = join(installation.dir, "moved-away");
  const moves = [
    join(installation.dir, "node_modules", "node-pty"),
    join(installation.serverDir, "dist", "server", "terminal-worker"),
    join(installation.serverDir, "dist", "server", "terminal", "shell-integration"),
  ].map((from, index) => ({ from, to: join(away, String(index)) }));
  mkdirSync(away, { recursive: true });
  for (const move of moves) renameSync(move.from, move.to);
  return () => {
    for (const move of moves) renameSync(move.to, move.from);
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  probe: () => Promise<T | null | false> | T | null | false,
  message: () => string | Promise<string>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(await message());
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(
  installation: Installation,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
    HOME: cliHome,
    USERPROFILE: cliHome,
    PASEO_HOME: paseoHome,
    PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    PASEO_DICTATION_ENABLED: "0",
    PASEO_VOICE_MODE_ENABLED: "0",
    // Each daemon hands its terminals its own installation's CLI.
    PASEO_CLI: installation.shim,
    PASEO_TEST_INSTALL: installation.name,
    SHELL: "/bin/sh",
    ...extraEnv,
  };
  return new Promise((resolve) => {
    execFile(installation.shim, args, { env, timeout: 120_000 }, (error, stdout, stderr) => {
      let exitCode = 0;
      if (error) exitCode = typeof error.code === "number" ? error.code : 1;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function paseo(
  installation: Installation,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const result = await run(installation, args, extraEnv);
  assert.equal(
    result.exitCode,
    0,
    `paseo ${args.join(" ")} (${installation.name}) failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

async function json<T>(installation: Installation, args: string[]): Promise<T> {
  return JSON.parse((await paseo(installation, [...args, "--json"])).stdout) as T;
}

async function capture(installation: Installation, terminalId: string): Promise<string> {
  const { lines } = await json<{ lines: string[] }>(installation, [
    "terminal",
    "capture",
    terminalId,
  ]);
  return lines.join("\n");
}

async function type(installation: Installation, terminalId: string, line: string) {
  await paseo(installation, ["terminal", "send-keys", terminalId, "-l", line]);
  await paseo(installation, ["terminal", "send-keys", terminalId, "Enter"]);
}

async function waitForScreen(installation: Installation, terminalId: string, text: string) {
  await waitFor(
    async () => (await capture(installation, terminalId)).includes(text),
    async () =>
      `terminal ${terminalId} never showed ${text}:\n${await capture(installation, terminalId)}`,
  );
}

// Opens a terminal, records its shell's pid, and prints a marker.
async function openTerminal(
  installation: Installation,
  name: string,
): Promise<{ id: string; pid: number }> {
  const terminal = await json<{ id: string }>(installation, [
    "terminal",
    "create",
    "--cwd",
    workDir,
    "--name",
    name,
  ]);
  const pidFile = join(workDir, `${name}.pid`);
  await type(installation, terminal.id, `echo $$ > '${pidFile}'; echo MARKER-${name}`);
  const pid = await waitFor(
    () =>
      existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()
        ? Number(readFileSync(pidFile, "utf8"))
        : null,
    () => `terminal ${name} never wrote its pid`,
  );
  await waitForScreen(installation, terminal.id, `MARKER-${name}`);
  trackedPids.push(pid);
  return { id: terminal.id, pid };
}

// The value of `$variable` in the terminal's shell, written to a file (a long path would wrap
// on screen).
async function echoVariable(
  installation: Installation,
  terminalId: string,
  label: string,
  variable: string,
): Promise<string> {
  const valueFile = join(workDir, `${label}.value`);
  await type(
    installation,
    terminalId,
    `printf '%s' "$${variable}" > '${valueFile}.tmp' && mv '${valueFile}.tmp' '${valueFile}'`,
  );
  await waitFor(
    () => existsSync(valueFile),
    async () =>
      `terminal ${terminalId} never wrote ${label}:\n${await capture(installation, terminalId)}`,
  );
  return readFileSync(valueFile, "utf8");
}

interface WorkerRecordFile {
  pid: number;
  protocolVersion: unknown;
  runtime?: string | null;
  terminals: Array<{ id: string; pid: number }>;
}

function workerRecords(): WorkerRecordFile[] {
  const dir = join(paseoHome, "terminal-worker");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as WorkerRecordFile);
}

function runtimeCopies(): string[] {
  const dir = join(paseoHome, "terminal-worker");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) =>
    existsSync(join(dir, name, "paseo-terminal-worker-runtime.json")),
  );
}

function commandLineOf(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile("ps", ["-ww", "-o", "command=", "-p", String(pid)], (_error, stdout) =>
      resolve(stdout.trim()),
    );
  });
}

async function terminalIds(installation: Installation): Promise<string[]> {
  return (await json<Array<{ id: string }>>(installation, ["terminal", "ls", "--all"])).map(
    (terminal) => terminal.id,
  );
}

async function startDaemon(installation: Installation, extraEnv: Record<string, string> = {}) {
  await paseo(installation, ["daemon", "start"], extraEnv);
}

async function stopDaemon(installation: Installation, keepTerminals = false) {
  await paseo(installation, [
    "daemon",
    "stop",
    "--home",
    paseoHome,
    ...(keepTerminals ? ["--keep-terminals"] : []),
  ]);
}

// A terminal in a worker reporting `protocolVersion`, left running by `stop --keep-terminals`.
async function leaveWorkerWithProtocol(
  installation: Installation,
  protocolVersion: number,
  name: string,
): Promise<{ terminal: { id: string; pid: number }; workerPid: number; runtime: string }> {
  await startDaemon(installation, {
    PASEO_TERMINAL_WORKER_PROTOCOL_OVERRIDE: String(protocolVersion),
  });
  const terminal = await openTerminal(installation, name);
  const [worker] = workerRecords();
  assert(worker, "the daemon started a worker");
  assert.equal(worker.protocolVersion, protocolVersion, "the worker reports the override");
  await stopDaemon(installation, true);
  return { terminal, workerPid: worker.pid, runtime: worker.runtime! };
}

const trackedPids: number[] = [];
const a = createInstallation("A", "0.98.0");
const b = createInstallation("B", "0.99.0");
let restoreA: (() => void) | null = null;
let passed = false;

try {
  for (const [field, value] of [
    ["daemon.listen", `127.0.0.1:${port}`],
    ["daemon.relay.enabled", "false"],
    ["features.dictation.enabled", "false"],
    ["features.voiceMode.enabled", "false"],
  ] as const) {
    await paseo(a, ["daemon", "config", "set", field, value]);
  }

  console.log("Test 1: a daemon from A runs its worker from a copy in the home");
  await startDaemon(a);
  const t1 = await openTerminal(a, "t1");
  const [firstWorker] = workerRecords();
  assert(firstWorker, "one worker runs");
  assert.match(firstWorker.runtime ?? "", /^0\.98\.0-[0-9a-f]{12}$/);
  const copyA = join(paseoHome, "terminal-worker", firstWorker.runtime!);
  assert(
    (await commandLineOf(firstWorker.pid)).includes(join(copyA, "terminal-worker.mjs")),
    "the worker runs the copy's bundle",
  );
  assert.equal(await echoVariable(a, t1.id, "CLI1", "PASEO_CLI"), a.shim, "T1 has A's CLI");
  console.log("✓ worker runs from", copyA, "\n");

  console.log("Test 2: B adopts the worker after A's runtime files are gone");
  await stopDaemon(a, true);
  restoreA = moveRuntimeAway(a);
  await startDaemon(b, zsh ? { SHELL: zsh } : {});
  assert.deepEqual(
    workerRecords().map((record) => record.pid),
    [firstWorker.pid],
    "B adopted the same worker instead of starting one",
  );
  assert((await terminalIds(b)).includes(t1.id), "T1 is listed by B");
  const t2 = await openTerminal(b, "t2");
  assert.equal(await echoVariable(b, t2.id, "INSTALL2", "PASEO_TEST_INSTALL"), "B");
  assert.equal(await echoVariable(b, t2.id, "CLI2", "PASEO_CLI"), b.shim, "T2 has B's CLI");
  if (zsh) {
    // Creating a zsh terminal reads Paseo's integration from the worker's copy (A's is gone);
    // a missing file would have failed the create.
    const zshVersion = await echoVariable(b, t2.id, "ZSH", "ZSH_VERSION");
    assert(zshVersion.length > 0, "T2 runs zsh with Paseo's shell integration");
  } else {
    console.log("  (zsh is not installed: the shell-integration check is skipped)");
  }
  assert.equal(await echoVariable(b, t1.id, "CLI1AGAIN", "PASEO_CLI"), a.shim, "T1 keeps A's CLI");
  console.log("✓ same worker, T2 uses B's environment, T1 still works\n");

  console.log("Test 3: daemon stop closes both terminals and deletes the copy");
  await stopDaemon(b);
  await waitFor(
    () => !isAlive(t1.pid) && !isAlive(t2.pid) && !isAlive(firstWorker.pid),
    () => "terminals or worker outlived daemon stop",
  );
  assert.deepEqual(workerRecords(), [], "no worker record is left");
  assert.deepEqual(runtimeCopies(), [], "no copy is left");
  restoreA();
  restoreA = null;
  console.log("✓ closed and cleaned up\n");

  console.log("Test 4: a worker one protocol version old drains");
  const old = await leaveWorkerWithProtocol(a, 0, "t3");
  await startDaemon(b);
  const workers = workerRecords();
  assert.equal(workers.length, 2, "the old worker drains beside a new one");
  const current = workers.find((record) => record.pid !== old.workerPid)!;
  assert.equal(current.protocolVersion, 1);
  assert.match(current.runtime ?? "", /^0\.99\.0-/);
  assert((await terminalIds(b)).includes(old.terminal.id), "the old worker's terminal is listed");
  await type(b, old.terminal.id, "echo still-served");
  await waitForScreen(b, old.terminal.id, "\nstill-served");
  const t4 = await openTerminal(b, "t4");
  assert.deepEqual(
    workerRecords()
      .find((record) => record.pid === current.pid)!
      .terminals.map((terminal) => terminal.id),
    [t4.id],
    "new terminals open in the current worker",
  );
  await paseo(b, ["terminal", "kill", old.terminal.id]);
  await waitFor(
    () => !isAlive(old.workerPid),
    () => `the drained worker ${old.workerPid} did not exit`,
  );
  await waitFor(
    () => !runtimeCopies().includes(old.runtime),
    () => `the drained worker's copy ${old.runtime} was not deleted: ${runtimeCopies().join(", ")}`,
  );
  assert.deepEqual(runtimeCopies(), [current.runtime], "the current worker's copy stays");
  await type(b, t4.id, "echo after-drain");
  await waitForScreen(b, t4.id, "\nafter-drain");
  await stopDaemon(b);
  console.log("✓ drained, exited, copy deleted\n");

  console.log("Test 5: a worker two protocol versions old is shut down");
  const obsolete = await leaveWorkerWithProtocol(a, -1, "t5");
  await startDaemon(b);
  await waitFor(
    () => !isAlive(obsolete.workerPid) && !isAlive(obsolete.terminal.pid),
    () => "the obsolete worker or its terminal survived",
  );
  assert(!(await terminalIds(b)).includes(obsolete.terminal.id), "its terminal is gone");
  assert.equal(workerRecords().length, 1, "one current worker runs");
  await stopDaemon(b);
  console.log("✓ shut down\n");

  console.log("Test 6: a worker from a newer Paseo is left running and reported");
  const newer = await leaveWorkerWithProtocol(a, 2, "t6");
  await startDaemon(b);
  const listed = await run(b, ["terminal", "ls", "--all", "--json"]);
  assert.notEqual(listed.exitCode, 0, "terminal ls fails");
  assert.match(listed.stdout + listed.stderr, /held by a newer Paseo \(v0\.98\.0/);
  const created = await run(b, ["terminal", "create", "--cwd", workDir, "--json"]);
  assert.notEqual(created.exitCode, 0, "terminal create fails");
  assert.match(created.stdout + created.stderr, /held by a newer Paseo/);
  const status = await paseo(b, ["daemon", "status", "--home", paseoHome]);
  assert.match(status.stdout, /terminals: Terminals are held by a newer Paseo/);
  assert(isAlive(newer.terminal.pid), "its program keeps running");
  assert.deepEqual(
    workerRecords().map((record) => record.pid),
    [newer.workerPid],
    "no second worker starts",
  );
  await stopDaemon(b);
  await waitFor(
    () => !isAlive(newer.workerPid) && !isAlive(newer.terminal.pid),
    () => "daemon stop left the newer worker or its terminal running",
  );
  assert.deepEqual(workerRecords(), [], "no worker record is left");
  assert.deepEqual(runtimeCopies(), [], "no copy is left");
  console.log("✓ reported, untouched, closed by stop\n");
  passed = true;
} finally {
  if (!passed) {
    for (const log of ["daemon.log", "terminal-worker.log"]) {
      const logPath = join(paseoHome, log);
      if (existsSync(logPath)) {
        console.error(`--- ${log} (last 60 lines) ---`);
        console.error(readFileSync(logPath, "utf8").split("\n").slice(-60).join("\n"));
      }
    }
  }
  restoreA?.();
  for (const installation of [b, a]) {
    await run(installation, ["daemon", "stop", "--home", paseoHome, "--force"]);
  }
  for (const pid of trackedPids) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  await rm(root, { recursive: true, force: true });
}

console.log("=== Terminal worker survives an upgrade passed ===");
