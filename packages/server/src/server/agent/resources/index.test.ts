import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createFakeResourceHost, fakeChild, type FakeResourceHost } from "./fake-host.js";
import type { ResourceHost } from "./host.js";
import { AgentResources } from "./index.js";
import { UnenforceableAgentResourcePolicyError } from "./policy.js";

function createResources(host: ResourceHost): AgentResources {
  return new AgentResources({ logger: createTestLogger(), namespace: "/home/test", host });
}

function busCalls(host: FakeResourceHost, method: string): string[][] {
  return host.commands.filter((command) => command.includes(method));
}

async function refusal(operation: Promise<unknown>) {
  const error = await operation.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof UnenforceableAgentResourcePolicyError)) {
    throw new Error(`Expected the policy to be refused, got ${String(error)}`);
  }
  return error.controls;
}

const TARGET = { command: "codex", args: ["app-server"], env: {} };
const ACCESS_DENIED = "Call failed: Access denied";
const NO_PROCESS = "No agent process is running; this applies when one starts";
const LINUX_ONLY = "Resource controls need a Linux host";
const NO_SYSTEMD =
  "Needs systemd and cgroup v2: systemd (busctl, systemd-run, systemctl) is not installed";
const SHARED_PROCESS =
  "This provider serves several agents from one process, so a per-agent limit cannot be applied";
const NICE_DENIED =
  "The daemon may not raise priority above its own (needs CAP_SYS_NICE or a higher RLIMIT_NICE)";
const NICE_RUNNING_DENIED =
  "The kernel refused to raise the priority of the running processes; reload the agent to apply this";

describe("AgentResources", () => {
  test("refuses every control outside Linux and runs no command", async () => {
    const host = createFakeResourceHost({ platform: "darwin" });
    const resources = createResources(host);
    const input = {
      agentId: "agent-1",
      policy: { nice: 10, memoryMaxMb: 1024 },
      sharedProcess: false,
    };

    expect(resources.supported).toBe(false);
    expect(await refusal(resources.open(input))).toEqual([
      { control: "nice", state: "unsupported", message: LINUX_ONLY },
      { control: "memoryMaxMb", state: "unsupported", message: LINUX_ONLY },
    ]);
    expect(host.commands).toEqual([]);
    expect(await resources.status(input)).toEqual({
      backend: "none",
      active: false,
      unit: null,
      cgroup: null,
      controls: {
        nice: { state: "unsupported", message: LINUX_ONLY },
        memoryMaxMb: { state: "unsupported", message: LINUX_ONLY },
      },
    });
  });

  test("opens an agent without a policy outside Linux as before", async () => {
    const resources = createResources(createFakeResourceHost({ platform: "win32" }));

    const lease = await resources.open({
      agentId: "agent-1",
      policy: undefined,
      sharedProcess: false,
    });

    expect(lease.launch).toBeUndefined();
  });

  test("leaves an agent without a policy unwrapped and creates no unit", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    const lease = await resources.open({
      agentId: "agent-1",
      policy: undefined,
      sharedProcess: false,
    });

    expect(lease.launch?.wrap(TARGET)).toEqual(TARGET);
    expect(busCalls(host, "StartTransientUnit")).toEqual([]);
  });

  test("starts the provider inside a slice named only from hashes", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    const agentId = "../../evil; rm -rf /";
    const lease = await resources.open({
      agentId,
      policy: { cpuQuotaPercent: 150, memoryMaxMb: 2048 },
      sharedProcess: false,
    });

    const slice = resources.sliceFor(agentId);
    expect(slice).toMatch(/^paseo_[0-9a-f]{10}-agent_[0-9a-f]{16}\.slice$/);
    expect(busCalls(host, "StartTransientUnit")).toEqual([
      [
        "/usr/bin/busctl",
        "--user",
        "call",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "StartTransientUnit",
        "ssa(sv)a(sa(sv))",
        slice,
        "fail",
        "3",
        "Description",
        "s",
        expect.stringMatching(/^Paseo agent [0-9a-f]{16}$/),
        "CPUQuotaPerSecUSec",
        "t",
        "1500000",
        "MemoryMax",
        "t",
        String(2048 * 1024 * 1024),
        "0",
      ],
    ]);
    const wrapped = lease.launch?.wrap(TARGET);
    expect(wrapped?.command).toBe("/usr/bin/systemd-run");
    expect(wrapped?.args).toEqual([
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--no-ask-password",
      `--slice=${slice}`,
      expect.stringMatching(/^--unit=paseo_[0-9a-f]{10}-agent_[0-9a-f]{16}-p\d+n1\.scope$/),
      "--property=TimeoutStopSec=3s",
      "--property=OOMPolicy=continue",
      "--expand-environment=no",
      "--",
      "codex",
      "app-server",
    ]);
    expect(wrapped?.env).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000" });
  });

  test("gives the provider back its own runtime directory when it differs from the manager's", async () => {
    const resources = createResources(createFakeResourceHost());
    const lease = await resources.open({
      agentId: "agent-1",
      policy: { cpuWeight: 10 },
      sharedProcess: false,
    });

    const wrapped = lease.launch?.wrap({ ...TARGET, env: { XDG_RUNTIME_DIR: "/tmp/sandbox" } });

    expect(wrapped?.env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(wrapped?.args).toContain("--setenv=XDG_RUNTIME_DIR=/tmp/sandbox");
  });

  test("encodes a CPU set as the byte mask systemd expects", async () => {
    const host = createFakeResourceHost({ effectiveCpus: "0-1,9" });
    const resources = createResources(host);
    await resources.open({
      agentId: "agent-1",
      policy: { allowedCpus: [0, 1, 9] },
      sharedProcess: false,
    });

    // CPUs 0 and 1 are bits 0-1 of byte 0 (3); CPU 9 is bit 1 of byte 1 (2). The
    // trailing "0" is the empty list of auxiliary units.
    expect(busCalls(host, "StartTransientUnit")[0]?.slice(-6)).toEqual([
      "AllowedCPUs",
      "ay",
      "2",
      "3",
      "2",
      "0",
    ]);
  });

  test("reaches the user manager when the daemon has no runtime directory in its environment", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    await resources.open({ agentId: "agent-1", policy: { cpuWeight: 10 }, sharedProcess: false });

    expect(host.calls.length).toBeGreaterThan(2);
    for (const call of host.calls) {
      expect(call.env).toEqual({ XDG_RUNTIME_DIR: "/run/user/1000" });
    }
  });

  test("starts the provider through nice, inside the scope, before it runs any code", async () => {
    const resources = createResources(createFakeResourceHost());
    const lease = await resources.open({
      agentId: "agent-1",
      policy: { nice: 12, memoryMaxMb: 1024 },
      sharedProcess: false,
    });

    const args = lease.launch?.wrap(TARGET).args ?? [];
    expect(args.slice(-6)).toEqual(["--", "/usr/bin/nice", "-n", "12", "codex", "app-server"]);
  });

  test("refuses a priority above the daemon's when the kernel would not grant it", async () => {
    for (const nice of ["gnu", "busybox"] as const) {
      const resources = createResources(createFakeResourceHost({ nice }));

      expect(
        await refusal(
          resources.open({ agentId: "agent-1", policy: { nice: -5 }, sharedProcess: false }),
        ),
      ).toEqual([{ control: "nice", state: "denied", message: NICE_DENIED }]);
    }
  });

  test("raises priority for a daemon that may", async () => {
    const resources = createResources(
      createFakeResourceHost({ systemd: false, mayRaisePriority: true }),
    );
    const lease = await resources.open({
      agentId: "agent-1",
      policy: { nice: -5 },
      sharedProcess: false,
    });

    expect(lease.launch?.wrap(TARGET)).toEqual({
      command: "/usr/bin/nice",
      args: ["-n", "-5", "codex", "app-server"],
      env: {},
    });
  });

  test("waits for a slice whose start is queued behind another job", async () => {
    const host = createFakeResourceHost({ activationStates: ["inactive", "activating"] });
    const resources = createResources(host);

    await resources.open({ agentId: "agent-1", policy: { cpuWeight: 10 }, sharedProcess: false });

    expect(busCalls(host, "--property=ActiveState")).toHaveLength(3);
  });

  test("stops any leftover slice of the same name before creating the agent's", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);

    await resources.open({ agentId: "agent-1", policy: { cpuWeight: 10 }, sharedProcess: false });

    const order = host.commands
      .map((command) => (command.includes("stop") ? "stop" : command[6]))
      .filter((step) => step === "stop" || step === "StartTransientUnit");
    expect(order).toEqual(["stop", "StartTransientUnit"]);
  });

  test("accepts a CPU set the kernel narrowed to CPUs the agent may use", async () => {
    const host = createFakeResourceHost({ availableCpus: "0-3", effectiveCpus: "0-3" });
    const resources = createResources(host);
    const policy = { allowedCpus: [0, 1, 2, 3, 4, 5, 6, 7] };
    await resources.open({ agentId: "agent-1", policy, sharedProcess: false });

    expect(
      (await resources.status({ agentId: "agent-1", policy, sharedProcess: false })).controls,
    ).toEqual({ allowedCpus: { state: "applied", actual: [0, 1, 2, 3] } });
  });

  test("refuses CPUs the host does not have before creating anything", async () => {
    const host = createFakeResourceHost({ availableCpus: "0-3" });
    const resources = createResources(host);

    expect(
      await refusal(
        resources.open({
          agentId: "agent-1",
          policy: { allowedCpus: [4, 5] },
          sharedProcess: false,
        }),
      ),
    ).toEqual([
      {
        control: "allowedCpus",
        state: "unsupported",
        message: "None of CPUs 4,5 is available to agents on this host (it has 0,1,2,3)",
      },
    ]);
    expect(busCalls(host, "StartTransientUnit")).toEqual([]);
  });

  test("stops the slice and fails the open when the kernel runs it on other CPUs than requested", async () => {
    const host = createFakeResourceHost({ effectiveCpus: "0-3" });
    const resources = createResources(host);

    expect(
      await refusal(
        resources.open({
          agentId: "agent-1",
          policy: { allowedCpus: [4, 5] },
          sharedProcess: false,
        }),
      ),
    ).toEqual([
      {
        control: "allowedCpus",
        state: "unsupported",
        message: "The host cannot confine the agent to CPUs 4,5; it would run on 0,1,2,3",
      },
    ]);
    // Once before the slice is created, once to remove it.
    const stop = ["/usr/bin/systemctl", "--user", "stop", resources.sliceFor("agent-1")];
    expect(busCalls(host, "stop")).toEqual([stop, stop]);
  });

  test("rejects the open when the slice cannot be created, so the provider never starts", async () => {
    const host = createFakeResourceHost({
      commandFailure: { argument: "StartTransientUnit", stderr: ACCESS_DENIED },
    });
    const resources = createResources(host);

    await expect(
      resources.open({ agentId: "agent-1", policy: { memoryMaxMb: 512 }, sharedProcess: false }),
    ).rejects.toThrow(`busctl failed: ${ACCESS_DENIED}`);
  });

  test("stops a slice it created when systemd then cannot report its cgroup", async () => {
    const host = createFakeResourceHost({
      commandFailure: { argument: "--property=ControlGroup", stderr: "Unit not loaded" },
    });
    const resources = createResources(host);

    await expect(
      resources.open({ agentId: "agent-1", policy: { memoryMaxMb: 512 }, sharedProcess: false }),
    ).rejects.toThrow("systemctl failed: Unit not loaded");
    // Once before the slice is created, once to remove it.
    const stop = ["/usr/bin/systemctl", "--user", "stop", resources.sliceFor("agent-1")];
    expect(busCalls(host, "stop")).toEqual([stop, stop]);
  });

  test("on a host without systemd applies niceness through nice and refuses cgroup limits", async () => {
    const host = createFakeResourceHost({ systemd: false, nice: "busybox" });
    const resources = createResources(host);

    expect(
      await refusal(
        resources.open({
          agentId: "agent-1",
          policy: { nice: 8, cpuQuotaPercent: 100 },
          sharedProcess: false,
        }),
      ),
    ).toEqual([{ control: "cpuQuotaPercent", state: "unsupported", message: NO_SYSTEMD }]);

    const policy = { nice: 8 };
    const lease = await resources.open({ agentId: "agent-1", policy, sharedProcess: false });
    expect(lease.launch?.wrap(TARGET)).toEqual({
      command: "/usr/bin/nice",
      args: ["-n", "8", "codex", "app-server"],
      env: {},
    });
    host.processes.add(4242);
    lease.launch?.attach(fakeChild(4242));
    // What `nice` does before it execs the provider.
    host.priorities.set(4242, 8);

    const status = await resources.status({ agentId: "agent-1", policy, sharedProcess: false });
    expect(status.backend).toBe("nice");
    expect(status.controls).toEqual({ nice: { state: "applied", actual: 8 } });
  });

  test("refuses niceness on a host with neither systemd nor a nice command", async () => {
    const resources = createResources(createFakeResourceHost({ systemd: false, nice: false }));

    expect((await resources.capabilities()).backend).toBe("none");
    expect(
      await refusal(
        resources.open({ agentId: "agent-1", policy: { nice: 8 }, sharedProcess: false }),
      ),
    ).toEqual([{ control: "nice", state: "unsupported", message: "Needs the nice command" }]);
  });

  test("refuses a control whose controller the manager was not delegated, and never writes it", async () => {
    const host = createFakeResourceHost({ controllers: "memory pids" });
    const resources = createResources(host);

    expect(
      await refusal(
        resources.open({
          agentId: "agent-1",
          policy: { cpuWeight: 50, memoryHighMb: 256 },
          sharedProcess: false,
        }),
      ),
    ).toEqual([
      {
        control: "cpuWeight",
        state: "unsupported",
        message: "The cpu cgroup controller is not delegated to the systemd user manager",
      },
    ]);
    expect(busCalls(host, "StartTransientUnit")).toEqual([]);

    const capabilities = await resources.capabilities();
    expect(capabilities.controls.allowedCpus.supported).toBe(false);
    expect(capabilities.controls.memoryMaxMb).toEqual({ supported: true });
  });

  test("refuses to bound a provider process that serves several agents", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    const input = { agentId: "agent-1", policy: { memoryMaxMb: 1024 }, sharedProcess: true };

    expect(await refusal(resources.open(input))).toEqual([
      { control: "memoryMaxMb", state: "unsupported", message: SHARED_PROCESS },
    ]);
    expect(busCalls(host, "StartTransientUnit")).toEqual([]);
    expect((await resources.status(input)).controls).toEqual({
      memoryMaxMb: { state: "unsupported", message: SHARED_PROCESS },
    });
  });

  test("reports a live priority raise the kernel refuses as denied, with the way out", async () => {
    const host = createFakeResourceHost({ systemd: false });
    const resources = createResources(host);
    const lease = await resources.open({
      agentId: "agent-1",
      policy: { nice: 15 },
      sharedProcess: false,
    });
    host.processes.add(4242);
    lease.launch?.attach(fakeChild(4242));
    host.priorities.set(4242, 15);

    await resources.update("agent-1", { nice: 5 });

    expect(
      (await resources.status({ agentId: "agent-1", policy: { nice: 5 }, sharedProcess: false }))
        .controls.nice,
    ).toEqual({ state: "denied", actual: 15, message: NICE_RUNNING_DENIED });
  });

  test("lowers the priority of a running agent's threads in place", async () => {
    const host = createFakeResourceHost({ systemd: false });
    const resources = createResources(host);
    const lease = await resources.open({
      agentId: "agent-1",
      policy: undefined,
      sharedProcess: false,
    });
    host.processes.add(4242);
    host.processes.add(4243);
    lease.launch?.attach(fakeChild(4242));
    lease.launch?.attach(fakeChild(4243));

    await resources.update("agent-1", { nice: 10 });

    expect([host.priorities.get(4242), host.priorities.get(4243)]).toEqual([10, 10]);
  });

  test("treats a process that exited before it could be reniced as nothing to report", async () => {
    const host = createFakeResourceHost({ systemd: false, setPriorityError: "ESRCH" });
    const resources = createResources(host);
    const lease = await resources.open({
      agentId: "agent-1",
      policy: undefined,
      sharedProcess: false,
    });
    lease.launch?.attach(fakeChild(4242));

    await resources.update("agent-1", { nice: 5 });

    expect(
      (await resources.status({ agentId: "agent-1", policy: { nice: 5 }, sharedProcess: false }))
        .controls.nice,
    ).toEqual({ state: "pending", message: NO_PROCESS });
  });

  test("reports niceness as applied only when every thread has it", async () => {
    const host = createFakeResourceHost({ systemd: false });
    const resources = createResources(host);
    const policy = { nice: 10 };
    const lease = await resources.open({ agentId: "agent-1", policy, sharedProcess: false });
    host.processes.add(4242);
    host.processes.add(4243);
    lease.launch?.attach(fakeChild(4242));
    lease.launch?.attach(fakeChild(4243));
    host.priorities.set(4242, 10);
    host.priorities.set(4243, 15);

    expect(
      (await resources.status({ agentId: "agent-1", policy, sharedProcess: false })).controls.nice,
    ).toEqual({ state: "failed", actual: 15, message: "Some threads have a different niceness" });
  });

  test("keeps reporting a cgroup limit whose removal the host refused", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    await resources.open({
      agentId: "agent-1",
      policy: { memoryMaxMb: 1024 },
      sharedProcess: false,
    });
    host.failCommands({ argument: "SetUnitProperties", stderr: ACCESS_DENIED });

    await resources.update("agent-1", {});

    expect(
      (await resources.status({ agentId: "agent-1", policy: {}, sharedProcess: false })).controls,
    ).toEqual({
      memoryMaxMb: {
        state: "denied",
        actual: null,
        message: `Removing this control failed: busctl failed: ${ACCESS_DENIED}`,
      },
    });
  });

  test("keeps reporting a launch-time niceness it could not restore when the policy drops it", async () => {
    const host = createFakeResourceHost({ systemd: false });
    const resources = createResources(host);
    const lease = await resources.open({
      agentId: "agent-1",
      policy: { nice: 15 },
      sharedProcess: false,
    });
    host.processes.add(4242);
    expect(lease.launch?.wrap(TARGET).command).toBe("/usr/bin/nice");
    lease.launch?.attach(fakeChild(4242));
    // What `nice -n 15` did before it exec'd the provider.
    host.priorities.set(4242, 15);

    await resources.update("agent-1", undefined);

    expect(
      (await resources.status({ agentId: "agent-1", policy: undefined, sharedProcess: false }))
        .controls,
    ).toEqual({
      nice: {
        state: "denied",
        actual: 15,
        message: `Removing this control failed: ${NICE_RUNNING_DENIED}`,
      },
    });
  });

  test("keeps a refused removal visible through later updates until one succeeds", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    const input = { agentId: "agent-1", policy: { cpuWeight: 10 }, sharedProcess: false };
    await resources.open({ ...input, policy: { memoryMaxMb: 1024 } });
    host.failCommands({ argument: "SetUnitProperties", stderr: ACCESS_DENIED });

    await resources.update("agent-1", {});
    await resources.update("agent-1", { cpuWeight: 10 });

    const failing = (await resources.status(input)).controls;
    expect(Object.keys(failing).sort()).toEqual(["cpuWeight", "memoryMaxMb"]);
    expect(failing.memoryMaxMb?.state).toBe("denied");

    host.failCommands(null);
    await resources.update("agent-1", { cpuWeight: 10 });

    expect(Object.keys((await resources.status(input)).controls)).toEqual(["cpuWeight"]);
  });

  test("reports a refused live update as denied", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    await resources.open({
      agentId: "agent-1",
      policy: { memoryMaxMb: 1024 },
      sharedProcess: false,
    });
    host.failCommands({ argument: "SetUnitProperties", stderr: ACCESS_DENIED });

    await resources.update("agent-1", { memoryMaxMb: 512 });
    const status = await resources.status({
      agentId: "agent-1",
      policy: { memoryMaxMb: 512 },
      sharedProcess: false,
    });

    expect(status.controls).toEqual({
      memoryMaxMb: { state: "denied", actual: null, message: `busctl failed: ${ACCESS_DENIED}` },
    });
  });

  test("keeps the slice while a reload overlaps and stops it with the last lease", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    const input = { agentId: "agent-1", policy: { cpuWeight: 10 }, sharedProcess: false };
    const first = await resources.open(input);
    const second = await resources.open(input);

    await first.release();
    await first.release();
    expect(busCalls(host, "stop")).toHaveLength(1);

    await second.release();
    // Once before the slice is created, once to remove it.
    const stop = ["/usr/bin/systemctl", "--user", "stop", resources.sliceFor("agent-1")];
    expect(busCalls(host, "stop")).toEqual([stop, stop]);
    expect(busCalls(host, "StartTransientUnit")).toHaveLength(1);
  });

  test("retries a slice it failed to stop before the agent opens again, and never reuses it", async () => {
    const host = createFakeResourceHost();
    const resources = createResources(host);
    const input = { agentId: "agent-1", policy: { cpuWeight: 10 }, sharedProcess: false };
    const lease = await resources.open(input);
    host.failCommands({ argument: "stop", stderr: "Job failed" });

    await lease.release();

    expect((await resources.status(input)).unit).toBe(resources.sliceFor("agent-1"));
    await expect(resources.open(input)).rejects.toThrow(
      "the agent's previous slice could not be stopped",
    );

    host.failCommands(null);
    await resources.open(input);

    expect(busCalls(host, "stop")).toHaveLength(5);
    expect(busCalls(host, "StartTransientUnit")).toHaveLength(2);
  });

  test("reports a stored policy for an agent with no runtime as pending", async () => {
    const resources = createResources(createFakeResourceHost());

    expect(
      (
        await resources.status({
          agentId: "agent-1",
          policy: { cpuWeight: 10 },
          sharedProcess: false,
        })
      ).controls,
    ).toEqual({ cpuWeight: { state: "pending", message: NO_PROCESS } });
  });
});
