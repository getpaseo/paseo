import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startDaemonInstance, readDaemonInstance } from "@getpaseo/server";
import { expect, test } from "vitest";
import { connectToDaemon } from "../../utils/client.js";

const repo = fileURLToPath(new URL("../../../../..", import.meta.url));
const cli = path.join(repo, "packages/cli/dist/index.js");

async function port() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (value === 6767 || value === 6768) throw new Error("Unsafe test port");
  return value;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo lifecycle "));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_"))),
    HOME: root,
    USERPROFILE: root,
  };
  const homes = [path.join(root, "a"), path.join(root, "b")];
  const owned = new Map<string, { pid: number; startedAt: string }>();
  async function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...env, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`CLI timed out: ${args.join(" ")}\n${stderr}`));
      }, 45_000);
      child.once("error", reject);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    for (const home of homes) {
      try {
        const lock = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
        owned.set(home, lock);
      } catch {
        /* No acquired launch. */
      }
    }
    return { code, stdout, stderr, json: () => JSON.parse(stdout) };
  }
  async function ok(args: string[], overrides?: NodeJS.ProcessEnv) {
    const result = await run(["--json", ...args], overrides);
    expect(result.code, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
    return result.json();
  }
  async function liveStatus(home: string, overrides?: NodeJS.ProcessEnv) {
    let status;
    await expect
      .poll(
        async () => {
          status = await ok(["status", "--home", home], overrides);
          return status.connectedDaemon;
        },
        { timeout: 30_000 },
      )
      .toBe("reachable");
    return status;
  }
  async function configure(home: string, listen: string) {
    for (const [field, value] of [
      ["daemon.listen", listen],
      ["daemon.relay.enabled", "false"],
      ["features.webUi.enabled", "false"],
      ["features.dictation.enabled", "false"],
      ["features.voiceMode.enabled", "false"],
    ]) {
      await ok(["daemon", "config", "set", field!, value!, "--home", home]);
    }
  }
  async function close() {
    for (const [home, captured] of owned) {
      try {
        const lock = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
        if (lock.pid === captured.pid && lock.startedAt === captured.startedAt) {
          await run(["daemon", "stop", "--home", home, "--force", "--timeout", "2"]);
        }
      } catch {
        /* Already exited. */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  return { root, homes, env, run, ok, liveStatus, configure, close };
}

test("managed two-home restart retains its supervisor and never routes ordinary commands or stop to the other home", async () => {
  const f = await fixture();
  const [a, b] = f.homes as [string, string];
  const portA = await port(),
    portB = await port(),
    movedPort = await port();
  try {
    await f.configure(a, `127.0.0.1:${portA}`);
    await f.configure(b, `127.0.0.1:${portB}`);
    const launchA = await f.ok(["start", "--home", a, "--timeout", "30"]);
    const poisoned = {
      PASEO_HOME: a,
      PASEO_HOST: `127.0.0.1:${portA}`,
      PASEO_LISTEN: `127.0.0.1:${portA}`,
      PORT: String(portA),
      PASEO_WEB_UI_ENABLED: "true",
      PASEO_RELAY_ENABLED: "true",
    };
    const launchB = await f.ok(["daemon", "start", "--home", b, "--timeout", "30"], poisoned);
    expect(launchA.listen).toBe(`127.0.0.1:${portA}`);
    expect(launchB.listen).toBe(`127.0.0.1:${portB}`);
    const beforeA = await f.liveStatus(a);
    const beforeB = await f.ok(["--home", b, "daemon", "status"], poisoned);
    if (process.platform !== "win32") {
      for (const home of [a, b, path.join(f.root, ".paseo")])
        expect((await stat(home)).mode & 0o777).toBe(0o700);
    }

    const repoB = path.join(f.root, "project-b");
    await mkdir(repoB);
    await f.ok(["project", "create", repoB, "--home", b], poisoned);
    expect(await f.ok(["project", "ls", "--home", a])).toEqual([]);
    expect((await f.ok(["project", "ls", "--home", b], poisoned)).length).toBe(1);
    const stream = await f.run(["logs", "missing-agent", "--follow", "--home", b], poisoned);
    expect(stream.stderr).toContain("Agent not found: missing-agent");
    const restart = await f.ok(["restart", "--home", b, "--timeout", "30"], poisoned);
    expect(restart.supervisorPid).toBe(launchB.pid);
    expect(restart.workerPid).not.toBe(beforeB.workerPid);
    const saved = await f.ok(
      ["daemon", "config", "set", "daemon.listen", `127.0.0.1:${movedPort}`, "--home", b],
      poisoned,
    );
    expect(saved.restartRequiredPaths).toContain("daemon.listen");
    await f.ok(["daemon", "restart", "--home", b, "--timeout", "30"], poisoned);
    const moved = await f.liveStatus(b);
    expect(moved.listen).toBe(`127.0.0.1:${movedPort}`);
    expect(moved.pid).toBe(launchB.pid);
    await f.ok(["daemon", "stop", "--home", b], poisoned);
    const stoppedQuery = await f.run(["--json", "project", "ls", "--home", b], poisoned);
    expect(stoppedQuery.code).toBe(1);
    expect(stoppedQuery.stderr).toContain("DAEMON_NOT_RUNNING");
    const afterA = await f.liveStatus(a);
    expect(afterA.workerPid).toBe(beforeA.workerPid);
    expect(afterA.pid).toBe(beforeA.pid);
    expect(await f.ok(["project", "ls", "--home", a])).toEqual([]);
  } finally {
    await f.close();
  }
}, 120_000);

test("removed flags and ambiguous targets fail before side effects; observation does not create a home", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  try {
    await f.ok(["status", "--home", home]);
    await f.ok(["daemon", "config", "get", "--home", home]);
    expect(existsSync(home)).toBe(false);
    for (const args of [
      ["start", "--port", "12345"],
      ["start", "--foreground"],
      ["daemon", "restart", "--no-relay"],
    ]) {
      const result = await f.run(["--json", ...args, "--home", home]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("REMOVED_LAUNCH_OPTION");
      expect(existsSync(home)).toBe(false);
    }
    const ambiguous = await f.run(["--home", home, "project", "ls", "--host", "unused:12345"]);
    expect(ambiguous.stderr).toContain("Choose either --home or --host");
    expect(existsSync(home)).toBe(false);
  } finally {
    await f.close();
  }
}, 30_000);

test("an occupied initial or replacement address fails without false readiness or killing its owner", async () => {
  const f = await fixture();
  const [a, b] = f.homes as [string, string];
  const portA = await port(),
    portB = await port();
  try {
    await f.configure(a, `127.0.0.1:${portA}`);
    await f.configure(b, `127.0.0.1:${portA}`);
    await f.ok(["start", "--home", a, "--timeout", "30"]);
    const before = await f.liveStatus(a);
    const failed = await f.run(["--json", "start", "--home", b, "--timeout", "30"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("DAEMON_START_FAILED");
    await f.ok(["daemon", "config", "set", "daemon.listen", `127.0.0.1:${portB}`, "--home", b]);
    await f.ok(["start", "--home", b, "--timeout", "30"]);
    await f.ok(["daemon", "config", "set", "daemon.listen", `127.0.0.1:${portA}`, "--home", b]);
    const restart = await f.run(["--json", "restart", "--home", b, "--timeout", "30"]);
    expect(restart.code).toBe(1);
    expect(restart.stderr).toContain("RESTART_NOT_CONFIRMED");
    await f.ok(["daemon", "stop", "--home", b]);
    expect((await f.liveStatus(a)).workerPid).toBe(before.workerPid);
  } finally {
    await f.close();
  }
}, 120_000);

test("a slow worker outlives the caller's readiness deadline and remains stoppable", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  try {
    await f.configure(home, `127.0.0.1:${await port()}`);
    const preload = path.join(f.root, "slow-worker.mjs");
    await writeFile(
      preload,
      'if (process.argv[1]?.endsWith("daemon-worker.js")) await new Promise(resolve => setTimeout(resolve, 5000));',
    );
    const launch = await f.run(["--json", "start", "--home", home, "--timeout", "1"], {
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    });
    expect(launch.code).toBe(1);
    expect(launch.stderr).toContain("DAEMON_NOT_READY");
    expect(launch.stderr).toContain("remains running");
    expect(launch.stderr).toContain("Logs:");
    expect(launch.stderr).toContain("Status:");
    expect(launch.stderr).toContain("Stop:");
    const pending = await f.ok(["status", "--home", home]);
    expect(pending.localDaemon).toBe("not_ready");
    expect(pending.listen).toBeNull();
    process.kill(pending.pid, 0);
    const already = await f.ok(["start", "--home", home]);
    expect(already.action).toBe("already_running");
    expect(already.pid).toBe(pending.pid);
    await f.ok(["project", "ls", "--home", home]);
    expect((await f.ok(["status", "--home", home])).pid).toBe(pending.pid);
    await f.ok(["daemon", "stop", "--home", home]);
  } finally {
    await f.close();
  }
}, 60_000);

test("worker restart preserves an already-running legacy supervisor's launch flags", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  const filePort = await port(),
    launchPort = await port();
  try {
    await f.configure(home, `127.0.0.1:${filePort}`);
    const launch = await startDaemonInstance({
      home,
      command: process.execPath,
      args: [
        path.join(repo, "packages/server/dist/scripts/supervisor-entrypoint.js"),
        "--no-relay",
        "--no-web-ui",
      ],
      // The legacy CLI translated --port into PASEO_LISTEN before spawning.
      env: { ...f.env, PASEO_LISTEN: `127.0.0.1:${launchPort}` },
      mode: "deployment",
      timeoutMs: 30_000,
    });
    const before = await f.liveStatus(home);
    expect(before.listen).toBe(`127.0.0.1:${launchPort}`);
    const restarted = await f.ok(["restart", "--home", home, "--timeout", "30"], {
      PASEO_LISTEN: `127.0.0.1:${filePort}`,
    });
    expect(restarted.supervisorPid).toBe(launch.instance.pid);
    expect(restarted.workerPid).not.toBe(before.workerPid);
    expect((await f.ok(["status", "--home", home])).listen).toBe(before.listen);
  } finally {
    await f.close();
  }
}, 60_000);

test.skipIf(process.platform === "win32")(
  "POSIX stop ignores a wrong endpoint even with copied identities; supported live identity overrides still restart",
  async () => {
    const f = await fixture();
    const [a, b] = f.homes as [string, string];
    try {
      await f.configure(a, `127.0.0.1:${await port()}`);
      await f.configure(b, `127.0.0.1:${await port()}`);
      await writeFile(path.join(b, "server-id"), "saved-b");
      await f.ok(["start", "--home", a, "--timeout", "30"]);
      await f.ok(["start", "--home", b, "--timeout", "30"], { PASEO_SERVER_ID: "live-b" });
      const beforeA = await f.liveStatus(a);
      expect((await f.liveStatus(b)).serverId).toBe("live-b");
      await f.ok(["restart", "--home", b, "--timeout", "30"]);
      const bLock = JSON.parse(await readFile(path.join(b, "paseo.pid"), "utf8"));
      await writeFile(
        path.join(b, "paseo.pid"),
        JSON.stringify({ ...bLock, listen: beforeA.listen }),
      );
      await writeFile(path.join(b, "server-id"), beforeA.serverId);
      await f.ok(["daemon", "stop", "--home", b]);
      expect((await f.liveStatus(a)).workerPid).toBe(beforeA.workerPid);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.skipIf(process.platform === "win32").each([["start"], ["daemon", "run"]])(
  "explicit cancellation before readiness cleans up only this launch: %j",
  async (...launchArgs) => {
    const f = await fixture();
    const home = f.homes[0]!;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await f.configure(home, `127.0.0.1:${await port()}`);
      const preload = path.join(f.root, "slow-worker.mjs");
      await writeFile(
        preload,
        'if (process.argv[1]?.endsWith("daemon-worker.js")) await new Promise(resolve => setTimeout(resolve, 30000));',
      );
      child = spawn(process.execPath, [cli, ...launchArgs, "--home", home], {
        cwd: repo,
        env: { ...f.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
        stdio: "ignore",
      });
      const exited = new Promise((resolve) => child!.once("exit", resolve));
      await expect
        .poll(async () => existsSync(path.join(home, "paseo.pid")), { timeout: 10_000 })
        .toBe(true);
      const lock = JSON.parse(await readFile(path.join(home, "paseo.pid"), "utf8"));
      await f.ok(["status", "--home", home]);
      child.kill("SIGINT");
      await exited;
      expect(() => process.kill(lock.pid, 0)).toThrow();
      expect((await f.ok(["status", "--home", home])).localDaemon).toBe("stopped");
    } finally {
      child?.kill("SIGTERM");
      await f.close();
    }
  },
  60_000,
);

test.runIf(process.platform === "win32")(
  "Windows unbound stop requires explicit force",
  async () => {
    const f = await fixture();
    const home = f.homes[0]!;
    try {
      await f.configure(home, `127.0.0.1:${await port()}`);
      const preload = path.join(f.root, "slow-worker.mjs");
      await writeFile(
        preload,
        'if (process.argv[1]?.endsWith("daemon-worker.js")) await new Promise(resolve => setTimeout(resolve, 30000));',
      );
      const pending = await f.run(["--json", "start", "--home", home, "--timeout", "1"], {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      });
      expect(pending.stderr).toContain("DAEMON_NOT_READY");
      const refused = await f.run(["--json", "daemon", "stop", "--home", home]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("STOP_NO_GRACEFUL_CHANNEL");
      const stopped = await f.ok(["daemon", "stop", "--home", home, "--force"]);
      expect(stopped.forced).toBe(true);
      expect(stopped.usedLifecycleRpc).toBe(false);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test("empty explicit selectors never select the ambient daemon or create local state", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  try {
    await f.configure(home, `127.0.0.1:${await port()}`);
    await f.ok(["start", "--home", home]);
    const before = await f.liveStatus(home);
    for (const args of [
      ["daemon", "stop", "--home", ""],
      ["daemon", "stop", "--host", ""],
      ["start", "--home", ""],
      ["daemon", "config", "set", "daemon.relay.enabled", "true", "--home", ""],
    ]) {
      const refused = await f.run(["--json", ...args], { PASEO_HOME: home });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("TARGET_INVALID");
      expect((await f.liveStatus(home)).workerPid).toBe(before.workerPid);
      expect(existsSync(path.join(f.root, "paseo.pid"))).toBe(false);
      expect(existsSync(path.join(f.root, "config.json"))).toBe(false);
    }
  } finally {
    await f.close();
  }
}, 60_000);

test("IPv6 publication supports home-selected query and worker restart", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  const endpoint = `[::1]:${await port()}`;
  try {
    await f.configure(home, endpoint);
    const launch = await f.ok(["start", "--home", home, "--timeout", "30"]);
    expect(launch.listen).toBe(endpoint);
    expect(await f.ok(["project", "ls", "--home", home])).toEqual([]);
    const restarted = await f.ok(["restart", "--home", home, "--timeout", "30"]);
    expect(restarted.supervisorPid).toBe(launch.pid);
    expect(restarted.workerPid).not.toBe(restarted.previousWorkerPid);
  } finally {
    await f.close();
  }
}, 60_000);

test("raw log following subscribes to a stored agent that exists only in B", async () => {
  const f = await fixture();
  const [a, b] = f.homes as [string, string];
  let follower: ReturnType<typeof spawn> | undefined;
  try {
    await f.configure(a, `127.0.0.1:${await port()}`);
    await f.configure(b, `127.0.0.1:${await port()}`);
    const agentId = "4de8b157-7614-4c38-b189-e50e57fb9498";
    const now = new Date().toISOString();
    await mkdir(path.join(b, "agents"));
    await writeFile(
      path.join(b, "agents", `${agentId}.json`),
      JSON.stringify({
        id: agentId,
        provider: "codex",
        cwd: f.root,
        title: "B-only stored agent",
        createdAt: now,
        updatedAt: now,
        lastStatus: "closed",
        persistence: null,
      }),
    );
    const launchA = await f.ok(["start", "--home", a]);
    await f.ok(["start", "--home", b]);
    const absent = await f.run(["logs", agentId, "--home", a]);
    expect(absent.stderr).toContain("Agent not found");
    follower = spawn(
      process.execPath,
      [cli, "logs", agentId, "--follow", "--tail", "0", "--home", b],
      {
        cwd: f.root,
        env: { ...f.env, PASEO_HOME: a, PASEO_HOST: launchA.listen },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    follower.stdout!.on("data", (data) => {
      output += data;
    });
    follower.stderr!.on("data", (data) => {
      errors += data;
    });
    await expect.poll(() => output, { timeout: 15_000 }).toContain("Following logs (no history;");
    expect(errors).not.toContain("Agent not found");
  } finally {
    if (follower && follower.exitCode === null) {
      const exited = new Promise((resolve) => follower!.once("exit", resolve));
      follower.kill("SIGINT");
      await exited;
    }
    await f.close();
  }
}, 60_000);

test("a connection pinned to an earlier supervisor refuses its replacement", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  try {
    await f.configure(home, `127.0.0.1:${await port()}`);
    await f.ok(["start", "--home", home]);
    const captured = (await readDaemonInstance(home))!;
    await f.ok(["daemon", "stop", "--home", home]);
    await f.ok(["start", "--home", home]);
    const before = await f.liveStatus(home);
    await expect(
      connectToDaemon({ target: { kind: "instance", home }, instance: captured, timeout: 1000 }),
    ).rejects.toMatchObject({ code: "DAEMON_REPLACED" });
    expect((await f.liveStatus(home)).workerPid).toBe(before.workerPid);
  } finally {
    await f.close();
  }
}, 60_000);

test("foreground deployment retains environment until its owner ends the launch; endpoint stop reports acknowledgment", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  const fileEndpoint = `127.0.0.1:${await port()}`,
    deploymentEndpoint = `127.0.0.1:${await port()}`,
    changedEndpoint = `127.0.0.1:${await port()}`;
  let deployment: ReturnType<typeof spawn> | undefined;
  try {
    await f.configure(home, fileEndpoint);
    deployment = spawn(process.execPath, [cli, "daemon", "run", "--home", home], {
      cwd: f.root,
      env: { ...f.env, PASEO_LISTEN: deploymentEndpoint, PASEO_RELAY_ENABLED: "false" },
      stdio: "ignore",
    });
    await expect
      .poll(async () => (await readDaemonInstance(home))?.listen, { timeout: 30_000 })
      .toBe(deploymentEndpoint);
    const before = await f.liveStatus(home);
    expect(before.configuredListen).toBe(fileEndpoint);
    expect(await f.ok(["daemon", "run", "--home", home])).toMatchObject({
      action: "already_running",
      pid: before.pid,
    });
    expect((await f.liveStatus(home)).workerPid).toBe(before.workerPid);
    const changed = await f.ok([
      "daemon",
      "config",
      "set",
      "daemon.listen",
      changedEndpoint,
      "--home",
      home,
    ]);
    expect(changed.overrideControlledPaths).toContain("daemon.listen");
    const restarted = await f.ok(["restart", "--home", home], { PASEO_LISTEN: fileEndpoint });
    expect(restarted.supervisorPid).toBe(before.pid);
    expect((await f.ok(["status", "--home", home])).listen).toBe(deploymentEndpoint);
    const exited = new Promise((resolve) => deployment!.once("exit", resolve));
    const remote = await f.ok(["daemon", "stop", "--host", deploymentEndpoint]);
    expect(remote.action).toBe("shutdown_requested");
    await exited;
    const managed = await f.ok(["start", "--home", home]);
    expect(managed.listen).toBe(changedEndpoint);
    expect(managed.pid).not.toBe(before.pid);
  } finally {
    if (deployment?.exitCode === null) deployment.kill("SIGTERM");
    await f.close();
  }
}, 90_000);

test("malformed configuration cannot turn a readiness timeout into launch cancellation", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  let starter: ReturnType<typeof spawn> | undefined;
  try {
    await f.configure(home, `127.0.0.1:${await port()}`);
    const configPath = path.join(home, "config.json");
    const saved = await readFile(configPath, "utf8");
    const preload = path.join(f.root, "slow-worker.mjs");
    await writeFile(
      preload,
      'if (process.argv[1]?.endsWith("daemon-worker.js")) await new Promise(resolve => setTimeout(resolve, 30000));',
    );
    starter = spawn(process.execPath, [cli, "--json", "start", "--home", home, "--timeout", "2"], {
      cwd: f.root,
      env: { ...f.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    starter.stderr!.on("data", (data) => {
      errors += data;
    });
    const exited = new Promise((resolve) => starter!.once("exit", resolve));
    await expect
      .poll(async () => (await readDaemonInstance(home))?.pid, { timeout: 10_000 })
      .toBeTruthy();
    const captured = (await readDaemonInstance(home))!;
    await f.ok(["status", "--home", home]);
    await writeFile(configPath, "{");
    await exited;
    expect(errors).toContain("DAEMON_NOT_READY");
    expect(errors).toContain(path.join(home, "daemon.log"));
    process.kill(captured.pid, 0);
    await writeFile(configPath, saved);
    await f.ok(["status", "--home", home]);
  } finally {
    if (starter?.exitCode === null) starter.kill("SIGTERM");
    await f.close();
  }
}, 60_000);

test("onboarding preserves an existing MCP choice unless explicitly supplied", async () => {
  const f = await fixture();
  const home = f.homes[0]!;
  try {
    await f.configure(home, `127.0.0.1:${await port()}`);
    await f.ok(["daemon", "config", "set", "daemon.mcp.enabled", "false", "--home", home]);
    for (const flags of [[], ["--no-mcp"]]) {
      const onboard = await f.run(["onboard", "--home", home, "--voice", "disable", ...flags]);
      expect(onboard.code, onboard.stderr).toBe(0);
      expect(
        (await f.ok(["daemon", "config", "get", "daemon.mcp.enabled", "--home", home])).value,
      ).toBe(false);
    }
  } finally {
    await f.close();
  }
}, 60_000);
