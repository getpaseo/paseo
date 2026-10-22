#!/usr/bin/env npx tsx

/**
 * Terminals survive `paseo daemon restart` and `stop --keep-terminals`; `restart
 * --kill-terminals`, `stop` and `stop --force` close them. Runs the built CLI and daemon in a
 * throwaway home; every process it starts is stopped in `finally`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { getAvailablePort } from "./helpers/network.ts";

if (process.platform === "win32") {
  console.log("Skipping terminal survival CLI test on Windows (POSIX shell terminals).");
  process.exit(0);
}

console.log("=== Daemon terminals survive restart ===\n");

const paseoHome = await mkdtemp(join(tmpdir(), "paseo-terminals-survive-"));
const workDir = join(paseoHome, "work");
await mkdir(workDir, { recursive: true });
const port = await getAvailablePort();
const env = {
  PASEO_HOME: paseoHome,
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  PASEO_DICTATION_ENABLED: "0",
  PASEO_VOICE_MODE_ENABLED: "0",
  // The daemon inherits this; terminals then run a plain POSIX shell with no startup files.
  SHELL: "/bin/sh",
};

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
  message: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function paseo(args: string[], expectSuccess = true) {
  const result = await runLocalPaseo(args, env);
  if (expectSuccess) {
    assert.equal(
      result.exitCode,
      0,
      `paseo ${args.join(" ")} failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function json<T>(args: string[]): Promise<T> {
  return JSON.parse((await paseo([...args, "--json"])).stdout) as T;
}

async function capture(terminalId: string): Promise<string> {
  const { lines } = await json<{ lines: string[] }>(["terminal", "capture", terminalId]);
  return lines.join("\n");
}

async function waitForScreen(terminalId: string, text: string): Promise<void> {
  await waitFor(
    async () => (await capture(terminalId)).includes(text),
    `terminal ${terminalId} never showed ${text}:\n${await capture(terminalId)}`,
  );
}

async function terminalIds(): Promise<string[]> {
  return (await json<Array<{ id: string }>>(["terminal", "ls", "--all"])).map((t) => t.id);
}

// Worker records and the cleanup records a kill that could not finish leaves beside them.
function workerRecordCount(): number {
  const dir = join(paseoHome, "terminal-worker");
  return existsSync(dir)
    ? readdirSync(dir).filter((name) => /^(\d+|closing-.+)\.json$/.test(name)).length
    : 0;
}

// A shell terminal that reports its pid and prints a marker.
async function openTerminal(name: string): Promise<{ id: string; pid: number }> {
  const terminal = await json<{ id: string }>([
    "terminal",
    "create",
    "--cwd",
    workDir,
    "--name",
    name,
  ]);
  const pidFile = join(workDir, `${name}.pid`);
  await paseo([
    "terminal",
    "send-keys",
    terminal.id,
    "-l",
    `echo $$ > '${pidFile}'; echo MARKER-${name}`,
  ]);
  await paseo(["terminal", "send-keys", terminal.id, "Enter"]);
  const pid = await waitFor(
    () =>
      existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()
        ? Number(readFileSync(pidFile, "utf8"))
        : null,
    `terminal ${name} never wrote its pid`,
  );
  await waitForScreen(terminal.id, `MARKER-${name}`);
  return { id: terminal.id, pid };
}

async function expectKept(terminal: { id: string; pid: number }, name: string, trigger: string) {
  assert((await terminalIds()).includes(terminal.id), `${trigger}: terminal is still listed`);
  assert(isAlive(terminal.pid), `${trigger}: terminal program is still alive`);
  assert((await capture(terminal.id)).includes(`MARKER-${name}`), `${trigger}: marker is kept`);
  await paseo(["terminal", "send-keys", terminal.id, "-l", `echo after-${trigger}`]);
  await paseo(["terminal", "send-keys", terminal.id, "Enter"]);
  await waitForScreen(terminal.id, `\nafter-${trigger}`);
}

async function expectClosed(pid: number, trigger: string) {
  await waitFor(() => !isAlive(pid), `${trigger}: terminal program ${pid} is still alive`, 15_000);
}

// A zombie: a real process with a birth time that SIGKILL cannot remove while its parent (an
// exec'd `sleep` that never waits) lives. Cleanup can only report it as still alive.
async function startZombie(): Promise<{ zombiePid: number; parentPid: number }> {
  const parent = spawn("/bin/sh", ["-c", "sleep 0 & echo $!; exec sleep 600"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const zombiePid = await new Promise<number>((resolve) => {
    parent.stdout!.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
  parent.unref();
  await waitFor(
    async () => (await psField(zombiePid, "stat")).startsWith("Z"),
    `process ${zombiePid} never became a zombie`,
  );
  return { zombiePid, parentPid: parent.pid! };
}

async function psField(pid: number, field: "stat" | "lstart"): Promise<string> {
  const child = spawn("ps", ["-o", `${field}=`, "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  await new Promise((resolve) => child.once("close", resolve));
  return out.trim();
}

async function goneProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid!;
}

// A record as a dead terminal worker leaves it, naming one terminal program that is a zombie.
async function plantRecordNaming(programPid: number): Promise<void> {
  const workerPid = await goneProcessPid();
  const record = {
    recordId: "planted-record",
    pid: workerPid,
    bootId: null,
    createdAt: new Date().toISOString(),
    identity: { startedAt: "Thu Jan  1 00:00:00 1970", commandLine: "planted-worker" },
    protocolVersion: 1,
    paseoVersion: "0.0.0-test",
    socketPath: join(paseoHome, "planted-worker.sock"),
    secret: "planted-secret",
    terminals: [
      { id: "planted-terminal", pid: programPid, startedAt: await psField(programPid, "lstart") },
    ],
  };
  writeFileSync(
    join(paseoHome, "terminal-worker", `${workerPid}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

const trackedPids: number[] = [];

try {
  for (const [field, value] of [
    ["daemon.listen", `127.0.0.1:${port}`],
    ["daemon.relay.enabled", "false"],
    ["features.dictation.enabled", "false"],
    ["features.voiceMode.enabled", "false"],
  ] as const) {
    await paseo(["daemon", "config", "set", field, value]);
  }
  await paseo(["daemon", "start"]);

  console.log("Test 1: daemon restart keeps the terminal");
  const kept = await openTerminal("kept");
  trackedPids.push(kept.pid);
  await paseo(["daemon", "restart", "--home", paseoHome]);
  await expectKept(kept, "kept", "restart");
  console.log("✓ same id, same program, marker and input after restart\n");

  console.log("Test 2: stop --keep-terminals, then start, gives the terminal back");
  const forceAndKeep = await paseo(
    ["daemon", "stop", "--home", paseoHome, "--force", "--keep-terminals"],
    false,
  );
  assert.notEqual(forceAndKeep.exitCode, 0, "--force with --keep-terminals is refused");
  await paseo(["daemon", "stop", "--home", paseoHome, "--keep-terminals"]);
  assert.equal(await readDaemonInstance(paseoHome), null, "the supervisor stopped");
  assert(isAlive(kept.pid), "the program outlives the stopped daemon");
  await paseo(["daemon", "start"]);
  await expectKept(kept, "kept", "keep-stop");
  console.log("✓ adopted with the same id and still usable\n");

  console.log("Test 3: a plain stop with no daemon running closes kept terminals");
  await paseo(["daemon", "stop", "--home", paseoHome, "--keep-terminals"]);
  assert(isAlive(kept.pid), "kept again");
  await paseo(["daemon", "stop", "--home", paseoHome]);
  await expectClosed(kept.pid, "stop without a supervisor");
  assert.equal(workerRecordCount(), 0, "no worker record is left");
  console.log("✓ closed\n");

  console.log("Test 4: restart --kill-terminals closes the terminal");
  await paseo(["daemon", "start"]);
  const killedByRestart = await openTerminal("restart-kill");
  trackedPids.push(killedByRestart.pid);
  await paseo(["daemon", "restart", "--home", paseoHome, "--kill-terminals"]);
  await expectClosed(killedByRestart.pid, "restart --kill-terminals");
  assert.deepEqual(await terminalIds(), [], "no terminal is listed after the kill restart");
  console.log("✓ closed\n");

  console.log("Test 5: daemon stop closes the terminal and its worker");
  const killedByStop = await openTerminal("stop-kill");
  trackedPids.push(killedByStop.pid);
  await paseo(["daemon", "stop", "--home", paseoHome]);
  await expectClosed(killedByStop.pid, "stop");
  assert.equal(workerRecordCount(), 0, "no worker record is left");
  console.log("✓ closed\n");

  console.log("Test 6: daemon stop --force closes the terminal");
  await paseo(["daemon", "start"]);
  const killedByForce = await openTerminal("force-kill");
  trackedPids.push(killedByForce.pid);
  await paseo(["daemon", "stop", "--home", paseoHome, "--force"]);
  await expectClosed(killedByForce.pid, "stop --force");
  assert.equal(workerRecordCount(), 0, "no worker record is left");
  console.log("✓ closed\n");

  const endpoint = `127.0.0.1:${port}`;
  console.log("Test 7: restart --host --kill-terminals closes the terminal");
  await paseo(["daemon", "start"]);
  const killedByEndpointRestart = await openTerminal("endpoint-restart-kill");
  trackedPids.push(killedByEndpointRestart.pid);
  await paseo(["daemon", "restart", "--host", endpoint, "--kill-terminals"]);
  await expectClosed(killedByEndpointRestart.pid, "restart --host --kill-terminals");
  assert.deepEqual(await terminalIds(), [], "no terminal is listed after the kill restart");
  console.log("✓ closed and confirmed by the replacement\n");

  console.log("Test 8: restart --host --kill-terminals reports a process cleanup could not end");
  const zombie = await startZombie();
  trackedPids.push(zombie.parentPid);
  await plantRecordNaming(zombie.zombiePid);
  const unconfirmed = await paseo(
    ["daemon", "restart", "--host", endpoint, "--kill-terminals"],
    false,
  );
  assert.notEqual(unconfirmed.exitCode, 0, "the kill restart fails");
  const output = unconfirmed.stdout + unconfirmed.stderr;
  assert(output.includes("Terminal cleanup was not confirmed"), `names the failure:\n${output}`);
  assert(output.includes(`pid ${zombie.zombiePid}`), `names the surviving pid:\n${output}`);
  process.kill(zombie.parentPid, "SIGKILL");
  await expectClosed(zombie.zombiePid, "zombie reaped once its parent exits");
  await paseo(["daemon", "stop", "--home", paseoHome]);
  assert.equal(workerRecordCount(), 0, "the next stop retries the cleanup and retires the record");
  console.log("✓ reported, then retried by stop\n");

  console.log("Test 9: restart --host --kill-terminals reports a worker record it cannot read");
  await paseo(["daemon", "start"]);
  // A kill cleanup cannot check what an unreadable record names, and leaves nothing else
  // behind, so the replacement daemon must still report it.
  const unreadablePath = join(paseoHome, "terminal-worker", `${await goneProcessPid()}.json`);
  writeFileSync(unreadablePath, "{ not json", { mode: 0o600 });
  const unreadable = await paseo(
    ["daemon", "restart", "--host", endpoint, "--kill-terminals"],
    false,
  );
  assert.notEqual(unreadable.exitCode, 0, "the kill restart fails");
  const unreadableOutput = unreadable.stdout + unreadable.stderr;
  assert(unreadableOutput.includes(unreadablePath), `names the record:\n${unreadableOutput}`);
  assert(existsSync(unreadablePath), "the unreadable record is kept");
  rmSync(unreadablePath);
  await paseo(["daemon", "stop", "--home", paseoHome]);
  assert.equal(workerRecordCount(), 0, "no worker record is left");
  console.log("✓ reported with the record's path\n");
} finally {
  await runLocalPaseo(["daemon", "stop", "--home", paseoHome, "--force"], env);
  for (const pid of trackedPids) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== Daemon terminals survive restart passed ===");
