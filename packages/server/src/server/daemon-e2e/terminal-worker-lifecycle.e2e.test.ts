import { afterEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { readDaemonInstance, stopDaemonInstance } from "../daemon-instance.js";
import { currentBootId } from "../pid-lock.js";
import { connectTerminalWorker } from "../../terminal/terminal-worker-client.js";
import { createTerminalWorkerProcessInspector } from "../../terminal/terminal-worker-processes.js";
import { reapTerminalWorkers } from "../../terminal/terminal-worker-reaper.js";
import { launchTerminalWorker } from "../../terminal/terminal-worker-launch.js";
import { prepareTerminalWorkerRuntime } from "../../terminal/terminal-worker-runtime.js";
import { createWorkerTerminalManager } from "../../terminal/worker-terminal-manager.js";
import {
  listTerminalWorkerRecords,
  writeTerminalWorkerRecord,
  type TerminalWorkerRecord,
} from "../../terminal/terminal-worker-record.js";

// Real supervisors started through scripts/supervisor-entrypoint.ts, driven by DaemonClient the
// way the app drives them. Every daemon, worker and program here lives in a throwaway home and
// is killed in afterEach; nothing touches another daemon.

const SERVER_ROOT = path.resolve(import.meta.dirname, "../../..");
const SUPERVISOR_ENTRY = path.join(SERVER_ROOT, "scripts/supervisor-entrypoint.ts");
const READY_TIMEOUT_MS = 90_000;
const POSIX = process.platform !== "win32";
const inspector = createTerminalWorkerProcessInspector();

interface Harness {
  home: string;
  workDir: string;
  port: number;
  supervisor: ChildProcess;
  output: () => string;
}

const harnesses: Harness[] = [];
const extraPids = new Set<number>();
const extraDirs: string[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  message: string,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${message}${lastError ? ` (last error: ${String(lastError)})` : ""}`);
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function startSupervisor(
  options: { home?: string; port?: number; pathPrefix?: string } = {},
): Promise<Harness> {
  const home = options.home ?? mkdtempSync(path.join(tmpdir(), "tw-life-"));
  const workDir = path.join(home, "work");
  mkdirSync(workDir, { recursive: true });
  const port = options.port ?? (await getAvailablePort());
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
    HOME: home,
    USERPROFILE: home,
    PASEO_HOME: home,
    PASEO_LISTEN: `127.0.0.1:${port}`,
    PASEO_RELAY_ENABLED: "false",
    PASEO_NODE_INSPECT: "0",
    PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    PASEO_DICTATION_ENABLED: "0",
    PASEO_VOICE_MODE_ENABLED: "0",
    CI: "true",
  };
  if (options.pathPrefix) {
    env.PATH = `${options.pathPrefix}${path.delimiter}${env.PATH ?? ""}`;
  }
  let output = "";
  const supervisor = spawn(
    process.execPath,
    ["--import", "tsx", SUPERVISOR_ENTRY, "--dev", "--no-relay"],
    { cwd: SERVER_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  supervisor.stdout?.on("data", (chunk) => (output = (output + String(chunk)).slice(-20_000)));
  supervisor.stderr?.on("data", (chunk) => (output = (output + String(chunk)).slice(-20_000)));
  const harness: Harness = { home, workDir, port, supervisor, output: () => output };
  harnesses.push(harness);
  await waitFor(async () => {
    const instance = await readDaemonInstance(home);
    return instance?.pid === supervisor.pid && instance.listen ? instance : null;
  }, `supervisor did not become ready:\n${output}`);
  return harness;
}

async function connect(harness: Harness): Promise<DaemonClient> {
  return waitFor(async () => {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${harness.port}/ws`,
      connectTimeoutMs: 5_000,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }, "cannot connect to the daemon");
}

// A plain `paseo daemon stop`: SIGTERM on POSIX, the shutdown RPC where there is no signal
// for it (Windows refuses a graceful stop without one).
async function stopDaemon(harness: Harness): Promise<void> {
  await stopDaemonInstance(harness.home, {
    requestShutdown: async () => {
      const client = await connect(harness);
      try {
        await client.shutdownServer();
      } finally {
        await client.close();
      }
    },
  });
}

async function daemonWorkerPid(client: DaemonClient): Promise<number> {
  return (await client.getDaemonStatus()).pid;
}

async function waitForReplacement(harness: Harness, previousPid: number): Promise<DaemonClient> {
  return waitFor(async () => {
    const client = await connect(harness);
    const pid = await daemonWorkerPid(client).catch(() => previousPid);
    if (pid !== previousPid) return client;
    await client.close();
    return null;
  }, "the daemon worker was not replaced");
}

async function createWorkspace(client: DaemonClient, harness: Harness): Promise<string> {
  const result = await client.createWorkspace({
    source: { kind: "directory", path: harness.workDir },
    title: "lifecycle",
  });
  if (!result.workspace) throw new Error(result.error ?? "workspace creation failed");
  return result.workspace.id;
}

interface MarkedTerminal {
  id: string;
  programPid: number;
}

// A terminal whose program writes its pid, prints a marker and echoes each input line.
async function createMarkedTerminal(
  client: DaemonClient,
  harness: Harness,
  workspaceId: string,
  marker: string,
): Promise<MarkedTerminal> {
  const pidFile = path.join(harness.workDir, `${marker}.pid`);
  const created = await client.createTerminal(harness.workDir, marker, undefined, {
    workspaceId,
    command: process.execPath,
    args: [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       console.log(${JSON.stringify(marker)});
       process.stdin.on("data", (data) => console.log("ECHO:" + data.toString().trim()));`,
    ],
  });
  if (!created.terminal) throw new Error(created.error ?? "terminal creation failed");
  const programPid = await waitFor(
    () => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null),
    "terminal program did not start",
    10_000,
  );
  await waitForScreen(client, created.terminal.id, marker);
  return { id: created.terminal.id, programPid };
}

// A shell program that ignores SIGHUP. With `exec`, the shell becomes `sleep`: same pid and
// birth time, another command line. Without it, `sleep` runs as the shell's child.
async function createHupResistantTerminal(
  client: DaemonClient,
  harness: Harness,
  workspaceId: string,
  name: string,
  mode: "exec" | "child",
): Promise<{ id: string; shellPid: number; sleepPid: number }> {
  const shellPidFile = path.join(harness.workDir, `${name}.shell.pid`);
  const sleepPidFile = path.join(harness.workDir, `${name}.sleep.pid`);
  const script =
    mode === "exec"
      ? `trap '' HUP; echo $$ > '${shellPidFile}'; echo $$ > '${sleepPidFile}'; exec sleep 100000`
      : `trap '' HUP; echo $$ > '${shellPidFile}'; sleep 100000 & echo $! > '${sleepPidFile}'; wait`;
  const created = await client.createTerminal(harness.workDir, name, undefined, {
    workspaceId,
    command: "/bin/sh",
    args: ["-c", script],
  });
  if (!created.terminal) throw new Error(created.error ?? "terminal creation failed");
  const read = (file: string) =>
    existsSync(file) && readFileSync(file, "utf8").trim()
      ? Number(readFileSync(file, "utf8").trim())
      : null;
  const shellPid = await waitFor(() => read(shellPidFile), "shell did not start", 10_000);
  const sleepPid = await waitFor(() => read(sleepPidFile), "sleep did not start", 10_000);
  extraPids.add(shellPid);
  extraPids.add(sleepPid);
  // `exec` replaces the shell; wait until the process really is `sleep`.
  await waitFor(
    async () => {
      const inspection = await inspector.inspect(sleepPid);
      return inspection.status === "alive" && inspection.snapshot.commandLine?.startsWith("sleep");
    },
    "sleep did not start",
    10_000,
  );
  return { id: created.terminal.id, shellPid, sleepPid };
}

async function screen(client: DaemonClient, terminalId: string): Promise<string> {
  return (await client.captureTerminal(terminalId, { stripAnsi: true })).lines.join("\n");
}

async function waitForScreen(client: DaemonClient, terminalId: string, text: string) {
  await waitFor(
    async () => (await screen(client, terminalId)).includes(text),
    `terminal ${terminalId} never showed ${text}`,
    15_000,
  );
}

async function expectKept(
  client: DaemonClient,
  terminal: MarkedTerminal,
  marker: string,
  trigger: string,
) {
  const listed = await client.listTerminals(undefined, undefined, {});
  expect(listed.terminals.map((entry) => entry.id)).toContain(terminal.id);
  expect(isAlive(terminal.programPid)).toBe(true);
  expect(await screen(client, terminal.id)).toContain(marker);
  client.sendTerminalInput(terminal.id, { type: "input", data: `after-${trigger}\r` });
  await waitForScreen(client, terminal.id, `ECHO:after-${trigger}`);
}

async function waitUntilGone(pid: number, what: string) {
  await waitFor(() => !isAlive(pid), `${what} (pid ${pid}) is still alive`, 15_000);
}

async function liveRecords(home: string): Promise<TerminalWorkerRecord[]> {
  return (await listTerminalWorkerRecords(home)).flatMap((file) =>
    "record" in file ? [file.record] : [],
  );
}

async function currentWorkerRecord(home: string): Promise<TerminalWorkerRecord> {
  const records = await liveRecords(home);
  if (records.length !== 1) throw new Error(`expected one worker record, found ${records.length}`);
  return records[0]!;
}

async function expectAllClosed(home: string, pids: number[]) {
  for (const pid of pids) {
    await waitUntilGone(pid, "a process that should be closed");
  }
  expect(await liveRecords(home)).toEqual([]);
}

function spawnUnrelated(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  extraPids.add(child.pid!);
  return child;
}

async function birthOf(pid: number): Promise<string> {
  const inspection = await inspector.inspect(pid);
  if (inspection.status !== "alive" || !inspection.snapshot.startedAt) {
    throw new Error(`no birth time for ${pid}`);
  }
  return inspection.snapshot.startedAt;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    const pid = harness.supervisor.pid;
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {
        // gone
      }
    }
    await stopDaemonInstance(harness.home, { force: true, timeoutMs: 15_000 }).catch(
      () => undefined,
    );
    if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
    for (const record of await liveRecords(harness.home)) {
      if (isAlive(record.pid)) {
        try {
          process.kill(record.pid, "SIGCONT");
        } catch {
          // gone
        }
      }
    }
    await reapTerminalWorkers({ paseoHome: harness.home, gracefulMs: 0 }).catch(() => undefined);
    rmSync(harness.home, { recursive: true, force: true });
  }
  for (const pid of extraPids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  extraPids.clear();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("terminals across daemon restarts", { timeout: 240_000 }, () => {
  test("Settings restart keeps the terminal; Settings restart and close terminals kills it", async () => {
    const harness = await startSupervisor();
    let client = await connect(harness);
    const workspaceId = await createWorkspace(client, harness);
    const terminal = await createMarkedTerminal(client, harness, workspaceId, "MARKER-SETTINGS");
    const workerPid = (await currentWorkerRecord(harness.home)).pid;

    // Exactly what the app sends from Settings: no killTerminals.
    let daemonPid = await daemonWorkerPid(client);
    await client.restartServer("settings_update");
    await client.close();
    client = await waitForReplacement(harness, daemonPid);
    await expectKept(client, terminal, "MARKER-SETTINGS", "settings-restart");
    expect((await currentWorkerRecord(harness.home)).pid).toBe(workerPid);

    daemonPid = await daemonWorkerPid(client);
    await client.restartServer("settings_update", undefined, { killTerminals: true });
    await client.close();
    client = await waitForReplacement(harness, daemonPid);
    await waitUntilGone(terminal.programPid, "terminal program");
    await waitUntilGone(workerPid, "old terminal worker");
    expect((await client.listTerminals(undefined, undefined, {})).terminals).toEqual([]);
    expect((await liveRecords(harness.home)).every((record) => record.pid !== workerPid)).toBe(
      true,
    );
    await client.close();
  });

  test("a daemon crash keeps the terminal; the restarted daemon lists it", async () => {
    const harness = await startSupervisor();
    let client = await connect(harness);
    const workspaceId = await createWorkspace(client, harness);
    const terminal = await createMarkedTerminal(client, harness, workspaceId, "MARKER-CRASH");
    const daemonPid = await daemonWorkerPid(client);
    process.kill(daemonPid, "SIGKILL");
    await client.close();
    client = await waitForReplacement(harness, daemonPid);
    await expectKept(client, terminal, "MARKER-CRASH", "crash");
    await client.close();
  });

  test("daemon.update.request restarts the daemon and keeps the terminal", async () => {
    // Fake npm only: `ls` reports this checkout as the global install at the daemon's
    // version, `install -g` does nothing, and anything else fails so real npm never runs.
    const fakeBin = mkdtempSync(path.join(tmpdir(), "tw-npm-"));
    extraDirs.push(fakeBin);
    const listing = JSON.stringify({
      path: path.join(fakeBin, "global"),
      dependencies: {
        "@getpaseo/cli": {
          version: resolveDaemonVersion(import.meta.url),
          path: SERVER_ROOT,
        },
      },
    });
    const fakeNpm = path.join(fakeBin, "fake-npm.cjs");
    writeFileSync(
      fakeNpm,
      `const args = process.argv.slice(2);
const has = (...tokens) => tokens.every((token) => args.includes(token));
if (has("-g", "ls", "@getpaseo/cli", "--json", "--depth=0", "--long")) {
  process.stdout.write(${JSON.stringify(listing)} + "\\n");
} else if (args[0] === "install" && has("-g", "@getpaseo/cli@latest")) {
  // The installed version is already the running one: nothing to do.
} else {
  process.stderr.write("unexpected npm call: " + args.join(" ") + "\\n");
  process.exit(1);
}
`,
    );
    const npmScript = path.join(fakeBin, "npm");
    writeFileSync(npmScript, `#!/bin/sh\nexec "${process.execPath}" "${fakeNpm}" "$@"\n`);
    chmodSync(npmScript, 0o755);
    writeFileSync(path.join(fakeBin, "npm.cmd"), `@"${process.execPath}" "${fakeNpm}" %*\r\n`);
    const harness = await startSupervisor({ pathPrefix: fakeBin });
    let client = await connect(harness);
    const workspaceId = await createWorkspace(client, harness);
    const terminal = await createMarkedTerminal(client, harness, workspaceId, "MARKER-UPDATE");
    const daemonPid = await daemonWorkerPid(client);

    const update = await client.updateDaemon();
    expect(update).toMatchObject({ success: true });
    await client.close();
    client = await waitForReplacement(harness, daemonPid);
    await expectKept(client, terminal, "MARKER-UPDATE", "update");
    await client.close();
  });

  test.skipIf(!POSIX)(
    "POSIX: a kill restart whose shutdown hangs closes terminals before the respawn",
    async () => {
      const harness = await startSupervisor();
      let client = await connect(harness);
      const workspaceId = await createWorkspace(client, harness);
      const terminal = await createMarkedTerminal(client, harness, workspaceId, "MARKER-HUNG");
      const daemonPid = await daemonWorkerPid(client);
      const supervisorPid = harness.supervisor.pid!;
      const logPath = path.join(harness.home, "daemon.log");

      // Barrier: the supervisor is paused, so the restart intent waits in its IPC channel.
      // The daemon's own log line marks the intent dispatched; then the daemon is paused, so
      // its graceful shutdown can never run and the supervisor's force path must.
      process.kill(supervisorPid, "SIGSTOP");
      await client.restartServer("settings_update", undefined, { killTerminals: true });
      await waitFor(
        () => readFileSync(logPath, "utf8").includes("Lifecycle intent dispatched"),
        "the daemon never dispatched the restart intent",
        15_000,
      );
      process.kill(daemonPid, "SIGSTOP");
      expect(isAlive(terminal.programPid)).toBe(true);
      process.kill(supervisorPid, "SIGCONT");
      await client.close();

      client = await waitForReplacement(harness, daemonPid);
      const log = readFileSync(logPath, "utf8");
      const forced = log.indexOf("forcing process tree kill");
      const cleaned = log.indexOf('"msg":"Terminal cleanup finished","when":"before_respawn"');
      const respawned = log.indexOf('"msg":"Spawning worker"', forced);
      expect(forced).toBeGreaterThan(-1);
      expect(cleaned).toBeGreaterThan(forced);
      expect(respawned).toBeGreaterThan(cleaned);
      expect(isAlive(terminal.programPid)).toBe(false);
      expect((await client.listTerminals(undefined, undefined, {})).terminals).toEqual([]);
      await client.close();
    },
  );
});

describe("terminals when the daemon stops", { timeout: 240_000 }, () => {
  test.skipIf(!POSIX)(
    "POSIX: stop closes a terminal whose program ignores HUP, child process included",
    async () => {
      const harness = await startSupervisor();
      const client = await connect(harness);
      const workspaceId = await createWorkspace(client, harness);
      const terminal = await createHupResistantTerminal(
        client,
        harness,
        workspaceId,
        "hup",
        "child",
      );
      const workerPid = (await currentWorkerRecord(harness.home)).pid;
      await client.close();
      await stopDaemon(harness);
      await expectAllClosed(harness.home, [terminal.shellPid, terminal.sleepPid, workerPid]);
    },
  );

  for (const force of [false, true]) {
    test.skipIf(!POSIX)(
      `POSIX: worker death reaps an exec'd HUP-resistant program and ${force ? "stop --force" : "stop"} closes its replacement`,
      async () => {
        const harness = await startSupervisor();
        const client = await connect(harness);
        const workspaceId = await createWorkspace(client, harness);
        const terminal = await createHupResistantTerminal(
          client,
          harness,
          workspaceId,
          "orphan",
          "exec",
        );
        const workerPid = (await currentWorkerRecord(harness.home)).pid;
        const daemonPid = await daemonWorkerPid(client);
        process.kill(workerPid, "SIGKILL");
        await waitUntilGone(workerPid, "terminal worker");
        await waitUntilGone(terminal.sleepPid, "orphaned terminal program");
        await waitFor(
          async () => (await client.listTerminals(undefined, undefined, {})).terminals.length === 0,
          "dead terminal was not removed",
        );
        expect(await daemonWorkerPid(client)).toBe(daemonPid);
        const replacement = await createMarkedTerminal(client, harness, workspaceId, "RECOVERED");
        await expectKept(client, replacement, "RECOVERED", "worker-death");
        await client.close();
        await stopDaemonInstance(harness.home, { force });
        await expectAllClosed(harness.home, [terminal.sleepPid, replacement.programPid]);
      },
    );
  }

  test.skipIf(!POSIX)(
    "POSIX: stop --force kills a stopped (SIGSTOP) worker and its terminal",
    async () => {
      const harness = await startSupervisor();
      const client = await connect(harness);
      const workspaceId = await createWorkspace(client, harness);
      const terminal = await createMarkedTerminal(client, harness, workspaceId, "MARKER-STOPPED");
      const workerPid = (await currentWorkerRecord(harness.home)).pid;
      await client.close();
      process.kill(workerPid, "SIGSTOP");
      await stopDaemonInstance(harness.home, { force: true });
      await expectAllClosed(harness.home, [workerPid, terminal.programPid]);
    },
  );

  test("the worker socket rejects a wrong secret and leaves its terminals alone", async () => {
    const harness = await startSupervisor();
    const client = await connect(harness);
    const workspaceId = await createWorkspace(client, harness);
    const terminal = await createMarkedTerminal(client, harness, workspaceId, "MARKER-AUTH");
    const record = await currentWorkerRecord(harness.home);
    await expect(
      connectTerminalWorker({ socketPath: record.socketPath, secret: "not-the-secret" }),
    ).rejects.toThrow();
    await expectKept(client, terminal, "MARKER-AUTH", "auth");
    await client.close();
  });

  test("stop and stop --force never signal processes a stale or earlier-boot record names", async () => {
    const harness = await startSupervisor();
    const client = await connect(harness);
    await client.close();
    const reused = spawnUnrelated();
    const earlierBoot = spawnUnrelated();
    const base = await currentWorkerRecord(harness.home);
    // Same pid, another birth time: what a reused pid looks like, whatever its command line.
    writeTerminalWorkerRecord(harness.home, {
      ...base,
      recordId: "stale-record",
      pid: reused.pid!,
      identity: { startedAt: "Thu Jan  1 00:00:00 1970", commandLine: "node -e setInterval" },
      terminals: [{ id: "t-stale", pid: reused.pid!, startedAt: "Thu Jan  1 00:00:00 1970" }],
    });
    // The right birth time, but written before this boot.
    writeTerminalWorkerRecord(harness.home, {
      ...base,
      recordId: "earlier-boot-record",
      pid: earlierBoot.pid!,
      bootId: currentBootId() ? "another-boot" : null,
      createdAt: "2000-01-01T00:00:00.000Z",
      identity: {
        startedAt: await birthOf(earlierBoot.pid!),
        commandLine: `node --paseo-terminal-worker earlier-boot-record`,
      },
      terminals: [
        { id: "t-boot", pid: earlierBoot.pid!, startedAt: await birthOf(earlierBoot.pid!) },
      ],
    });

    await stopDaemon(harness);
    expect(isAlive(reused.pid!)).toBe(true);
    expect(isAlive(earlierBoot.pid!)).toBe(true);
    expect(await liveRecords(harness.home)).toEqual([]);

    // A second round through --force, with the stale record put back.
    writeTerminalWorkerRecord(harness.home, {
      ...base,
      recordId: "stale-record",
      pid: reused.pid!,
      identity: { startedAt: "Thu Jan  1 00:00:00 1970", commandLine: "node -e setInterval" },
      terminals: [{ id: "t-stale", pid: reused.pid!, startedAt: "Thu Jan  1 00:00:00 1970" }],
    });
    await stopDaemonInstance(harness.home, { force: true });
    expect(isAlive(reused.pid!)).toBe(true);
    expect(await liveRecords(harness.home)).toEqual([]);
  });
});

describe("a worker launched from its own copy", { timeout: 240_000 }, () => {
  // What a built daemon does: bundle the worker, copy bundle + shell integration + node-pty into
  // the home, launch from the copy. Here the copy's node-pty (ConPTY on Windows) opens a real
  // terminal; nothing is loaded from this checkout once the worker runs.
  test("opens a terminal and runs a command from the copied bundle and node-pty", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "tw-copy-home-"));
    const bundleDirectory = mkdtempSync(path.join(tmpdir(), "tw-copy-bundle-"));
    extraDirs.push(home, bundleDirectory);
    const buildScript = path.join(SERVER_ROOT, "scripts/build-terminal-worker.mjs");
    const { buildTerminalWorkerBundle } = (await import(buildScript)) as {
      buildTerminalWorkerBundle(input: { outDir: string }): Promise<void>;
    };
    await buildTerminalWorkerBundle({ outDir: bundleDirectory });
    const nodePtyDirectory = path.dirname(
      createRequire(import.meta.url).resolve("node-pty/package.json"),
    );
    const entry = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "0.0.0-copy",
      bundleDirectory,
      nodePtyDirectory,
    });

    const launched = await launchTerminalWorker({
      paseoHome: home,
      paseoVersion: "0.0.0-copy",
      entry,
    });
    extraPids.add(launched.record.pid);
    expect(launched.record.runtime).toBe(entry.runtime);
    const manager = createWorkerTerminalManager({
      worker: await connectTerminalWorker({
        socketPath: launched.record.socketPath,
        secret: launched.record.secret,
      }),
      closeTerminals: async () => {
        await reapTerminalWorkers({ paseoHome: home });
      },
    });
    try {
      const session = await manager.createTerminal({
        workspaceId: "ws-copy",
        cwd: home,
        command: process.execPath,
        args: ["-e", "console.log('COPY-' + 'OK'); setInterval(() => {}, 1000);"],
      });
      await waitFor(
        async () =>
          (await manager.captureTerminal(session.id, { stripAnsi: true })).lines
            .join("\n")
            .includes("COPY-OK"),
        "the terminal in the copied worker never printed its marker",
        30_000,
      );
    } finally {
      await manager.closeTerminals();
    }
    expect(isAlive(launched.record.pid)).toBe(false);
    expect(existsSync(path.dirname(entry.scriptPath))).toBe(false);
  });
});
