import type { AgentResourcePolicy } from "@getpaseo/protocol/agent-resources";
import {
  ResourceHostCommandError,
  readCgroupControllers,
  readEffectiveCpus,
  type ResourceHost,
} from "./host.js";
import type { ResourceLaunchTarget } from "./launch.js";

const SYSTEMD_DESTINATION = "org.freedesktop.systemd1";
const SYSTEMD_PATH = "/org/freedesktop/systemd1";
const SYSTEMD_MANAGER = "org.freedesktop.systemd1.Manager";
const CGROUP_ROOT = "/sys/fs/cgroup";
/** systemd's "not set" for every unsigned 64-bit resource property. */
const UNSET = "18446744073709551615";
const BYTES_PER_MB = 1024 * 1024;
/** `CPUQuotaPerSecUSec` is CPU time per second in microseconds: one full CPU is 1000000. */
const CPU_QUOTA_USEC_PER_PERCENT = 10_000;
/** How long a stopped agent's leftover processes get after SIGTERM before SIGKILL. */
const SCOPE_STOP_TIMEOUT = "3s";
const SCOPE_OOM_POLICY_MIN_VERSION = 253;
const EXPAND_ENVIRONMENT_MIN_VERSION = 254;
const UNIT_ACTIVATION_POLL_MS = 25;
const UNIT_ACTIVATION_ATTEMPTS = 80;

/** The controller each cgroup-backed control needs delegated to the manager. */
export const CONTROLLER_BY_CONTROL = {
  cpuWeight: "cpu",
  cpuQuotaPercent: "cpu",
  memoryHighMb: "memory",
  memoryMaxMb: "memory",
  allowedCpus: "cpuset",
} as const;

export type CgroupControl = keyof typeof CONTROLLER_BY_CONTROL;

export const CGROUP_CONTROLS = Object.keys(CONTROLLER_BY_CONTROL) as CgroupControl[];

export interface SliceProperties {
  unit: string;
  policy: AgentResourcePolicy;
  /** Controls to write. One that the policy leaves unset is reset to "no limit". */
  controls: readonly CgroupControl[];
}

export interface TransientSlice extends SliceProperties {
  description: string;
}

export interface ScopedLaunch {
  slice: string;
  scope: string;
  target: ResourceLaunchTarget;
}

/** A systemd manager this daemon can create units in. */
export interface Systemd {
  /** The per-user manager, or the system one when the daemon runs as root. */
  readonly bus: "user" | "system";
  /** cgroup controllers the manager can hand to its units. */
  readonly controllers: ReadonlySet<string>;
  /** CPUs the manager's units can run on, or null when it has no cpuset controller. */
  readAvailableCpus(): Promise<number[] | null>;
  /** Creates the transient slice, empty, and waits until it is active. */
  startSlice(slice: TransientSlice): Promise<void>;
  /** Changes a live slice. Nothing is written that outlives the unit. */
  setSliceProperties(properties: SliceProperties): Promise<void>;
  /** Stops a unit and everything in it, waiting until its processes are gone. */
  stopUnit(unit: string): Promise<void>;
  /** Absolute cgroup directory of a loaded unit, or null when it has none. */
  readUnitCgroupDir(unit: string): Promise<string | null>;
  /**
   * Rewrites a launch to start inside `slice`. `systemd-run --scope` registers its own
   * process as the scope and then execs the command in place, so the PID, stdio pipes,
   * signals and exit status the caller sees are the command's own, and no child of the
   * command can exist outside the scope.
   */
  scopedLaunch(launch: ScopedLaunch): ResourceLaunchTarget;
}

export type SystemdDetection =
  | { available: true; systemd: Systemd }
  | { available: false; reason: string };

interface SystemdConnection {
  host: ResourceHost;
  bus: "user" | "system";
  busctl: string;
  systemdRun: string;
  systemctl: string;
  controllers: ReadonlySet<string>;
  /** The manager's own cgroup, the parent of every slice it creates for us. */
  cgroupDir: string;
  /** Where the user manager's bus socket lives; null for the system manager. */
  runtimeDir: string | null;
  /** systemd's major version, or 0 when it could not be read. */
  version: number;
}

function parseBusString(output: string): string | null {
  const match = /^s "(.*)"\s*$/.exec(output);
  return match ? match[1] : null;
}

function cpuMask(cpus: readonly number[]): string[] {
  const bytes = Array.from({ length: Math.floor(Math.max(...cpus) / 8) + 1 }, () => 0);
  for (const cpu of cpus) {
    bytes[Math.floor(cpu / 8)] |= 1 << (cpu % 8);
  }
  return [String(bytes.length), ...bytes.map(String)];
}

function unsignedProperty(name: string, value: number | undefined): string[] {
  return [name, "t", value === undefined ? UNSET : String(value)];
}

function scaled(value: number | undefined, factor: number): number | undefined {
  return value === undefined ? undefined : value * factor;
}

/** One D-Bus `(sv)` property as busctl arguments: name, signature, value. */
function propertyArgs(control: CgroupControl, policy: AgentResourcePolicy): string[] {
  switch (control) {
    case "cpuWeight":
      return unsignedProperty("CPUWeight", policy.cpuWeight);
    case "cpuQuotaPercent":
      return unsignedProperty(
        "CPUQuotaPerSecUSec",
        scaled(policy.cpuQuotaPercent, CPU_QUOTA_USEC_PER_PERCENT),
      );
    case "memoryHighMb":
      return unsignedProperty("MemoryHigh", scaled(policy.memoryHighMb, BYTES_PER_MB));
    case "memoryMaxMb":
      return unsignedProperty("MemoryMax", scaled(policy.memoryMaxMb, BYTES_PER_MB));
    case "allowedCpus":
      return ["AllowedCPUs", "ay", ...(policy.allowedCpus ? cpuMask(policy.allowedCpus) : ["0"])];
  }
}

/** A unit systemd could not bring to the state the daemon needs. */
export class SystemdUnitError extends Error {
  constructor(
    public readonly unit: string,
    public readonly reason: string,
  ) {
    super(`${unit}: ${reason}`);
    this.name = "SystemdUnitError";
  }
}

function createSystemd(connection: SystemdConnection): Systemd {
  const { host, bus, busctl, systemdRun, systemctl, runtimeDir, version } = connection;
  // A daemon started outside a login session has neither XDG_RUNTIME_DIR nor
  // DBUS_SESSION_BUS_ADDRESS, and the systemd tools cannot find a lingering user
  // manager without one of them.
  const env: Record<string, string> = runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {};

  function callManager(method: string, signature: string, args: string[]): Promise<string> {
    return host.exec({
      command: busctl,
      args: [
        `--${bus}`,
        "call",
        SYSTEMD_DESTINATION,
        SYSTEMD_PATH,
        SYSTEMD_MANAGER,
        method,
        signature,
        ...args,
      ],
      env,
    });
  }

  async function showUnitProperty(unit: string, property: string): Promise<string> {
    const output = await host.exec({
      command: systemctl,
      args: [`--${bus}`, "show", unit, `--property=${property}`, "--value"],
      env,
    });
    return output.trim();
  }

  /**
   * StartTransientUnit only queues a job. Waits until the unit is active, so a job
   * that fails is reported as the unit's state and not as a missing cgroup later.
   */
  async function waitForUnitActive(unit: string): Promise<void> {
    let state = "";
    for (let attempt = 0; attempt < UNIT_ACTIVATION_ATTEMPTS; attempt += 1) {
      state = await showUnitProperty(unit, "ActiveState");
      if (state === "active") {
        return;
      }
      // `inactive` is also how a start still queued behind another job looks.
      if (state === "failed") {
        break;
      }
      await host.sleep(UNIT_ACTIVATION_POLL_MS);
    }
    throw new SystemdUnitError(unit, `systemd did not activate it (state: ${state || "unknown"})`);
  }

  async function stopUnit(unit: string): Promise<void> {
    await host.exec({ command: systemctl, args: [`--${bus}`, "stop", unit], env });
  }

  async function setSliceProperties(properties: SliceProperties): Promise<void> {
    const { unit, policy, controls } = properties;
    if (controls.length === 0) {
      return;
    }
    await callManager("SetUnitProperties", "sba(sv)", [
      unit,
      "true",
      String(controls.length),
      ...controls.flatMap((control) => propertyArgs(control, policy)),
    ]);
  }

  return {
    bus,
    controllers: connection.controllers,
    readAvailableCpus: () => readEffectiveCpus(host, connection.cgroupDir),
    setSliceProperties,
    async startSlice(slice) {
      const { unit, policy, controls, description } = slice;
      const configured = controls.filter((control) => policy[control] !== undefined);
      // systemd accepts a start for a slice that already exists and leaves what is in
      // it alone. A slice of this name is a leftover the daemon no longer tracks, and
      // joining it would put its processes in the new runtime's boundary.
      await stopUnit(unit);
      await callManager("StartTransientUnit", "ssa(sv)a(sa(sv))", [
        unit,
        "fail",
        String(configured.length + 1),
        "Description",
        "s",
        description,
        ...configured.flatMap((control) => propertyArgs(control, policy)),
        "0",
      ]);
      await waitForUnitActive(unit);
    },
    stopUnit,
    async readUnitCgroupDir(unit) {
      const path = await showUnitProperty(unit, "ControlGroup");
      return path ? `${CGROUP_ROOT}${path}` : null;
    },
    scopedLaunch({ slice, scope, target }) {
      // systemd-run needs the manager's runtime directory; the command keeps its own.
      const ownRuntimeDir = target.env.XDG_RUNTIME_DIR;
      const restoresRuntimeDir =
        runtimeDir !== null && ownRuntimeDir !== undefined && ownRuntimeDir !== runtimeDir;
      return {
        command: systemdRun,
        args: [
          `--${bus}`,
          "--scope",
          "--quiet",
          "--collect",
          "--no-ask-password",
          `--slice=${slice}`,
          `--unit=${scope}`,
          `--property=TimeoutStopSec=${SCOPE_STOP_TIMEOUT}`,
          // By default systemd stops the whole scope, provider included, as soon as the
          // kernel kills one process in it for memory. Older versions cannot change that.
          ...(version >= SCOPE_OOM_POLICY_MIN_VERSION ? ["--property=OOMPolicy=continue"] : []),
          // Without this, systemd-run rewrites "$VAR" and "$$" inside the command's
          // arguments. Older versions never expand for --scope and reject the option.
          ...(version >= EXPAND_ENVIRONMENT_MIN_VERSION ? ["--expand-environment=no"] : []),
          ...(restoresRuntimeDir ? [`--setenv=XDG_RUNTIME_DIR=${ownRuntimeDir}`] : []),
          "--",
          target.command,
          ...target.args,
        ],
        env: { ...target.env, ...env },
      };
    },
  };
}

export async function detectSystemd(host: ResourceHost): Promise<SystemdDetection> {
  const [busctl, systemdRun, systemctl] = await Promise.all([
    host.findExecutable("busctl"),
    host.findExecutable("systemd-run"),
    host.findExecutable("systemctl"),
  ]);
  if (!busctl || !systemdRun || !systemctl) {
    return {
      available: false,
      reason: "systemd (busctl, systemd-run, systemctl) is not installed",
    };
  }
  const bus = host.uid === 0 ? "system" : "user";
  const runtimeDir = bus === "user" ? (host.env.XDG_RUNTIME_DIR ?? `/run/user/${host.uid}`) : null;
  const readManagerProperty = async (property: string): Promise<string | null> => {
    const output = await host.exec({
      command: busctl,
      args: [
        `--${bus}`,
        "get-property",
        SYSTEMD_DESTINATION,
        SYSTEMD_PATH,
        SYSTEMD_MANAGER,
        property,
      ],
      ...(runtimeDir ? { env: { XDG_RUNTIME_DIR: runtimeDir } } : {}),
    });
    return parseBusString(output);
  };
  let managerCgroup: string | null;
  let versionText: string | null;
  try {
    managerCgroup = await readManagerProperty("ControlGroup");
    versionText = await readManagerProperty("Version");
  } catch (error) {
    if (!(error instanceof ResourceHostCommandError)) {
      throw error;
    }
    return {
      available: false,
      reason: `the systemd ${bus} manager is not reachable (${error.stderr.trim()})`,
    };
  }
  if (managerCgroup === null) {
    return { available: false, reason: `the systemd ${bus} manager did not report its cgroup` };
  }
  const cgroupDir = `${CGROUP_ROOT}${managerCgroup}`;
  const controllers = await readCgroupControllers(host, cgroupDir);
  if (controllers === null) {
    return { available: false, reason: "the systemd manager does not run on cgroup v2" };
  }
  return {
    available: true,
    systemd: createSystemd({
      host,
      bus,
      busctl,
      systemdRun,
      systemctl,
      controllers,
      cgroupDir,
      runtimeDir,
      // Distributions report versions such as "257.9-1.fc45" or "255 (255.4-1ubuntu8)".
      version: Number.parseInt(/\d+/.exec(versionText ?? "")?.[0] ?? "0", 10),
    }),
  };
}
