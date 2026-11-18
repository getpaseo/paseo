import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { createResourceHost } from "./host.js";
import { AgentResources, type AgentResourceLease } from "./index.js";

// Runs against the real systemd user manager, real cgroups and real processes. It
// needs a Linux host whose user manager delegates the cpu and memory controllers.
// Run it with `npx vitest run src/server/agent/resources/systemd.local.e2e.test.ts`.
const bus = process.getuid?.() === 0 ? "system" : "user";

function cgroupOf(pid: number): string {
  return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unitState(unit: string): string {
  return execFileSync("systemctl", [`--${bus}`, "show", unit, "--property=ActiveState", "--value"])
    .toString()
    .trim();
}

function readLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += String(chunk);
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        child.stdout?.off("data", onData);
        child.off("exit", onExit);
        resolve(buffered.slice(0, newline));
      }
    };
    const onExit = () => reject(new Error(`process ended without a full line: ${buffered}`));
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

/**
 * Stands in for a provider: a shell that reports its own PID and a child's, then
 * serves stdin line by line the way a provider serves its protocol.
 */
const PROVIDER_SCRIPT = 'sleep 300 & echo "$$ $!"; while read line; do echo "echo:$line"; done';

/** A provider whose first act is to fork: the child exists before the parent returns. */
const IMMEDIATE_FORK_SCRIPT = 'sleep 300 & echo "$$ $!"; while read line; do :; done';
const IMMEDIATE_FORK_RUNS = 25;

interface FakeProvider {
  child: ChildProcess;
  pid: number;
  grandchildPid: number;
}

async function startProvider(lease: AgentResourceLease, script = PROVIDER_SCRIPT) {
  const child = spawnProcess("sh", ["-c", script], {
    stdio: ["pipe", "pipe", "pipe"],
    resources: lease.launch,
  });
  const [pid, grandchildPid] = (await readLine(child)).split(" ").map(Number);
  return { child, pid, grandchildPid } satisfies FakeProvider;
}

describe("agent resources on systemd", () => {
  const managers: AgentResources[] = [];

  function createManager(namespace = randomUUID()): AgentResources {
    const manager = new AgentResources({ logger: createTestLogger(), namespace });
    managers.push(manager);
    return manager;
  }

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  });

  test("runs the provider in place: same pid, working stdio, signals delivered", async () => {
    const manager = createManager();
    const lease = await manager.open({
      agentId: randomUUID(),
      policy: { cpuQuotaPercent: 50 },
      sharedProcess: false,
    });
    const provider = await startProvider(lease);

    expect(provider.pid).toBe(provider.child.pid);

    provider.child.stdin?.write("ping\n");
    expect(await readLine(provider.child)).toBe("echo:ping");

    provider.child.kill("SIGTERM");
    expect(await once(provider.child, "exit")).toEqual([null, "SIGTERM"]);
  });

  test("gives concurrent agents independent limits and leaves the daemon alone", async () => {
    const manager = createManager();
    const daemonCgroup = cgroupOf(process.pid);
    const [first, second] = [randomUUID(), randomUUID()];
    const firstPolicy = { cpuQuotaPercent: 200, cpuWeight: 100, memoryMaxMb: 8192 };
    const secondPolicy = {
      cpuQuotaPercent: 50,
      cpuWeight: 20,
      memoryMaxMb: 2048,
      memoryHighMb: 1024,
    };
    const firstLease = await manager.open({
      agentId: first,
      policy: firstPolicy,
      sharedProcess: false,
    });
    const secondLease = await manager.open({
      agentId: second,
      policy: secondPolicy,
      sharedProcess: false,
    });
    const firstProvider = await startProvider(firstLease);
    const secondProvider = await startProvider(secondLease);

    // The provider and the process it started are both inside their own agent's slice.
    expect(cgroupOf(firstProvider.pid)).toContain(`/${manager.sliceFor(first)}/`);
    expect(cgroupOf(firstProvider.grandchildPid)).toBe(cgroupOf(firstProvider.pid));
    expect(cgroupOf(secondProvider.pid)).toContain(`/${manager.sliceFor(second)}/`);
    expect(cgroupOf(secondProvider.grandchildPid)).toBe(cgroupOf(secondProvider.pid));
    expect(cgroupOf(process.pid)).toBe(daemonCgroup);

    const firstStatus = await manager.status({
      agentId: first,
      policy: firstPolicy,
      sharedProcess: false,
    });
    const secondStatus = await manager.status({
      agentId: second,
      policy: secondPolicy,
      sharedProcess: false,
    });
    expect(firstStatus.controls).toEqual({
      cpuQuotaPercent: { state: "applied", actual: 200 },
      cpuWeight: { state: "applied", actual: 100 },
      memoryMaxMb: { state: "applied", actual: 8192 },
    });
    expect(secondStatus.controls).toEqual({
      cpuQuotaPercent: { state: "applied", actual: 50 },
      cpuWeight: { state: "applied", actual: 20 },
      memoryMaxMb: { state: "applied", actual: 2048 },
      memoryHighMb: { state: "applied", actual: 1024 },
    });
    // The kernel's own files agree with what status reports.
    expect(readFileSync(`${firstStatus.cgroup}/cpu.max`, "utf8").trim()).toBe("200000 100000");
    expect(readFileSync(`${secondStatus.cgroup}/memory.max`, "utf8").trim()).toBe(
      String(2048 * 1024 * 1024),
    );
  });

  test("changes a running agent's limits without restarting it or touching another agent", async () => {
    const manager = createManager();
    const [target, bystander] = [randomUUID(), randomUUID()];
    const bystanderPolicy = { cpuQuotaPercent: 300, memoryMaxMb: 4096 };
    const targetLease = await manager.open({
      agentId: target,
      policy: { cpuQuotaPercent: 200, memoryMaxMb: 8192, memoryHighMb: 4096 },
      sharedProcess: false,
    });
    const bystanderLease = await manager.open({
      agentId: bystander,
      policy: bystanderPolicy,
      sharedProcess: false,
    });
    const provider = await startProvider(targetLease);
    await startProvider(bystanderLease);

    // memoryHighMb is dropped from the policy, so its limit must be lifted.
    const updated = { nice: 15, cpuWeight: 50, cpuQuotaPercent: 100, memoryMaxMb: 4096 };
    await manager.update(target, updated);

    expect(isAlive(provider.pid)).toBe(true);
    const status = await manager.status({ agentId: target, policy: updated, sharedProcess: false });
    expect(status.controls).toEqual({
      nice: { state: "applied", actual: 15 },
      cpuWeight: { state: "applied", actual: 50 },
      cpuQuotaPercent: { state: "applied", actual: 100 },
      memoryMaxMb: { state: "applied", actual: 4096 },
    });
    expect(readFileSync(`${status.cgroup}/memory.high`, "utf8").trim()).toBe("max");
    // Niceness reached the process the provider had already started.
    expect(os.getPriority(provider.grandchildPid)).toBe(15);

    const bystanderStatus = await manager.status({
      agentId: bystander,
      policy: bystanderPolicy,
      sharedProcess: false,
    });
    expect(bystanderStatus.controls).toEqual({
      cpuQuotaPercent: { state: "applied", actual: 300 },
      memoryMaxMb: { state: "applied", actual: 4096 },
    });
    expect(os.getPriority(process.pid)).toBe(os.getPriority());
  });

  test("passes arguments to the provider byte for byte", async () => {
    const manager = createManager();
    const lease = await manager.open({
      agentId: randomUUID(),
      policy: { cpuWeight: 50 },
      sharedProcess: false,
    });
    const args = ["$HOME", "$$", "${PATH}", "%h %n", '{"a":"b c"}', "--", "-p", ""];
    const child = spawnProcess("printf", ["%s\\n", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      resources: lease.launch,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    await once(child, "close");

    expect(output.split("\n")).toEqual([...args, ""]);
  });

  test("starts the provider and a child it forks at once at the configured niceness, every time", async () => {
    const manager = createManager();
    const policy = { nice: 12, cpuWeight: 50 };
    for (let run = 0; run < IMMEDIATE_FORK_RUNS; run += 1) {
      const lease = await manager.open({ agentId: randomUUID(), policy, sharedProcess: false });
      const provider = await startProvider(lease, IMMEDIATE_FORK_SCRIPT);
      expect([os.getPriority(provider.pid), os.getPriority(provider.grandchildPid)]).toEqual([
        12, 12,
      ]);
      process.kill(provider.grandchildPid, "SIGKILL");
      await lease.release();
    }
  });

  test("kills what a crashed provider left behind when the agent is closed", async () => {
    const manager = createManager();
    const agentId = randomUUID();
    const lease = await manager.open({
      agentId,
      policy: { memoryMaxMb: 1024 },
      sharedProcess: false,
    });
    // The child ignores SIGTERM, the way a stuck subprocess would.
    const provider = await startProvider(
      lease,
      `sh -c 'trap "" TERM; sleep 300' & echo "$$ $!"; while read line; do :; done`,
    );

    provider.child.kill("SIGKILL");
    await once(provider.child, "exit");
    expect(isAlive(provider.grandchildPid)).toBe(true);

    await lease.release();

    expect(isAlive(provider.grandchildPid)).toBe(false);
    expect(unitState(manager.sliceFor(agentId))).toBe("inactive");
  });

  test("removes on startup the slices a crashed daemon of the same home left", async () => {
    const namespace = randomUUID();
    const crashed = new AgentResources({ logger: createTestLogger(), namespace });
    const agentId = randomUUID();
    const lease = await crashed.open({
      agentId,
      policy: { cpuQuotaPercent: 50 },
      sharedProcess: false,
    });
    const provider = await startProvider(lease);

    await createManager(namespace).start();

    expect(isAlive(provider.pid)).toBe(false);
    expect(unitState(crashed.sliceFor(agentId))).toBe("inactive");
  });

  test("reopens an agent right after it closed, in a fresh slice with the new limits", async () => {
    const manager = createManager();
    const agentId = randomUUID();
    const first = await manager.open({
      agentId,
      policy: { memoryMaxMb: 1024 },
      sharedProcess: false,
    });
    const old = await startProvider(first);
    await first.release();

    const policy = { memoryMaxMb: 2048, cpuQuotaPercent: 50 };
    const second = await manager.open({ agentId, policy, sharedProcess: false });
    const provider = await startProvider(second);

    expect(isAlive(old.grandchildPid)).toBe(false);
    expect(cgroupOf(provider.pid)).toContain(`/${manager.sliceFor(agentId)}/`);
    expect((await manager.status({ agentId, policy, sharedProcess: false })).controls).toEqual({
      memoryMaxMb: { state: "applied", actual: 2048 },
      cpuQuotaPercent: { state: "applied", actual: 50 },
    });
  });

  test("removes a leftover slice of the agent's name instead of joining its processes", async () => {
    const manager = createManager();
    const agentId = randomUUID();
    const slice = manager.sliceFor(agentId);
    // A process in the agent's slice that this daemon knows nothing about.
    const stray = spawn(
      "systemd-run",
      [`--${bus}`, "--scope", "--quiet", "--collect", `--slice=${slice}`, "sleep", "300"],
      { stdio: "ignore" },
    );
    await expect.poll(() => unitState(slice)).toBe("active");

    const policy = { memoryMaxMb: 1024 };
    const lease = await manager.open({ agentId, policy, sharedProcess: false });
    const provider = await startProvider(lease);

    expect(stray.exitCode !== null || stray.signalCode !== null || !isAlive(stray.pid ?? 0)).toBe(
      true,
    );
    expect(cgroupOf(provider.pid)).toContain(`/${slice}/`);
    expect((await manager.status({ agentId, policy, sharedProcess: false })).controls).toEqual({
      memoryMaxMb: { state: "applied", actual: 1024 },
    });
  });

  test("an out-of-memory kill takes the process over the limit and leaves the provider running", async () => {
    const manager = createManager();
    const agentId = randomUUID();
    const policy = { memoryMaxMb: 64 };
    const lease = await manager.open({ agentId, policy, sharedProcess: false });
    // Without this a host with swap pages the excess out and nothing is killed.
    execFileSync("systemctl", [
      `--${bus}`,
      "set-property",
      "--runtime",
      manager.sliceFor(agentId),
      "MemorySwapMax=0",
    ]);
    // `tail` buffers a line that never ends, far past the 64 MB limit. It is the only
    // process allocating, and marks itself as the kernel's first choice.
    const hog = "(echo 1000 >/proc/self/oom_score_adj; exec tail -n 1 /dev/zero)";
    const child = spawnProcess(
      "sh",
      ["-c", `${hog}; echo "status:$?"; read line; echo "echo:$line"`],
      { stdio: ["pipe", "pipe", "pipe"], resources: lease.launch },
    );

    expect(await readLine(child)).toBe("status:137");
    child.stdin?.write("still here\n");
    expect(await readLine(child)).toBe("echo:still here");
    child.kill("SIGKILL");
  });

  test("refuses a policy the host cannot enforce and starts nothing", async () => {
    const manager = createManager();
    const agentId = randomUUID();

    await expect(
      manager.open({ agentId, policy: { allowedCpus: [1023] }, sharedProcess: false }),
    ).rejects.toThrow("Cannot enforce the resource policy. allowedCpus:");
    expect(unitState(manager.sliceFor(agentId))).toBe("inactive");
  });

  test("leaves an agent without a policy exactly where the daemon is", async () => {
    const manager = createManager();
    const agentId = randomUUID();
    const lease = await manager.open({ agentId, policy: undefined, sharedProcess: false });
    const provider = await startProvider(lease);

    expect(cgroupOf(provider.pid)).toBe(cgroupOf(process.pid));
    expect(await manager.status({ agentId, policy: undefined, sharedProcess: false })).toEqual({
      backend: "systemd",
      active: true,
      unit: null,
      cgroup: null,
      controls: {},
    });

    provider.child.kill("SIGKILL");
    await once(provider.child, "exit");
    process.kill(provider.grandchildPid, "SIGKILL");
    await lease.release();
  });

  test("reports cgroup limits set on a running unbounded agent as pending, and renices it", async () => {
    const manager = createManager();
    const agentId = randomUUID();
    const lease = await manager.open({ agentId, policy: undefined, sharedProcess: false });
    const provider = await startProvider(lease);
    const policy = { nice: 10, memoryMaxMb: 2048 };

    await manager.update(agentId, policy);

    const status = await manager.status({ agentId, policy, sharedProcess: false });
    expect(status.controls).toEqual({
      nice: { state: "applied", actual: 10 },
      memoryMaxMb: {
        state: "pending",
        message:
          "The running agent was started without a resource boundary; reload the agent to apply this",
      },
    });
    expect(os.getPriority(provider.grandchildPid)).toBe(10);

    provider.child.kill("SIGKILL");
    await once(provider.child, "exit");
    process.kill(provider.grandchildPid, "SIGKILL");
    await lease.release();
  });
});

describe("agent resources without systemd", () => {
  test("starts the provider and a child it forks at once at the configured niceness, every time", async () => {
    const realHost = createResourceHost();
    // A Linux host on which systemd is not installed.
    const host = {
      ...realHost,
      findExecutable: (name: string) =>
        name === "nice" ? realHost.findExecutable(name) : Promise.resolve(null),
    };
    const manager = new AgentResources({
      logger: createTestLogger(),
      namespace: randomUUID(),
      host,
    });
    expect((await manager.capabilities()).backend).toBe("nice");
    const policy = { nice: 11 };
    for (let run = 0; run < IMMEDIATE_FORK_RUNS; run += 1) {
      const agentId = randomUUID();
      const lease = await manager.open({ agentId, policy, sharedProcess: false });
      const provider = await startProvider(lease, IMMEDIATE_FORK_SCRIPT);
      expect([os.getPriority(provider.pid), os.getPriority(provider.grandchildPid)]).toEqual([
        11, 11,
      ]);
      expect((await manager.status({ agentId, policy, sharedProcess: false })).controls).toEqual({
        nice: { state: "applied", actual: 11 },
      });
      provider.child.kill("SIGKILL");
      process.kill(provider.grandchildPid, "SIGKILL");
      await lease.release();
    }
  });

  test("refuses cgroup limits instead of starting the provider without them", async () => {
    const realHost = createResourceHost();
    const manager = new AgentResources({
      logger: createTestLogger(),
      namespace: randomUUID(),
      host: { ...realHost, findExecutable: async () => null },
    });

    await expect(
      manager.open({ agentId: randomUUID(), policy: { memoryMaxMb: 512 }, sharedProcess: false }),
    ).rejects.toThrow(
      "Cannot enforce the resource policy. memoryMaxMb: Needs systemd and cgroup v2",
    );
  });
});
