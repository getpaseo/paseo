#!/usr/bin/env npx tsx

/**
 * Terminals survive `paseo daemon restart` and `stop --keep-terminals`; `restart
 * --kill-terminals`, `stop` and `stop --force` close them. Runs the built CLI and daemon in a
 * throwaway home; every process it starts is stopped in `finally`.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

function workerRecordCount(): number {
  const dir = join(paseoHome, "terminal-worker");
  return existsSync(dir) ? readdirSync(dir).filter((name) => /^\d+\.json$/.test(name)).length : 0;
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
} finally {
  await runLocalPaseo(["daemon", "stop", "--home", paseoHome, "--force"], env);
  for (const pid of trackedPids) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  await rm(paseoHome, { recursive: true, force: true });
}

console.log("=== Daemon terminals survive restart passed ===");
