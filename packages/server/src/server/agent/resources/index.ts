import { createHash } from "node:crypto";
import type { Logger } from "pino";
import {
  AGENT_RESOURCE_CONTROLS,
  isEmptyAgentResourcePolicy,
  type AgentResourceBackend,
  type AgentResourceControl,
  type AgentResourceControlStatus,
  type AgentResourcePolicy,
  type AgentResourceStatus,
} from "@getpaseo/protocol/agent-resources";
import {
  createResourceHost,
  errnoOf,
  isPermissionFailure,
  listCgroupThreads,
  listProcessTreeThreads,
  readCgroupLimits,
  ResourceHostCommandError,
  type CgroupLimits,
  type ResourceHost,
} from "./host.js";
import type { AgentResourceLaunch, ResourceLaunchTarget } from "./launch.js";
import { UnenforceableAgentResourcePolicyError, type UnenforceableControl } from "./policy.js";
import {
  CGROUP_CONTROLS,
  CONTROLLER_BY_CONTROL,
  detectSystemd,
  SystemdUnitError,
  type CgroupControl,
  type Systemd,
  type SystemdDetection,
} from "./systemd.js";

/** One open provider session's hold on its agent's boundary. */
export interface AgentResourceLease {
  /** Undefined when the provider's processes are not placed or tracked per agent. */
  readonly launch: AgentResourceLaunch | undefined;
  /** Call once the session is closed. The boundary is removed with its last lease. */
  release(): Promise<void>;
}

export interface AgentResourceRequest {
  policy: AgentResourcePolicy | undefined;
  /** The provider serves several agents from one process, so nothing can be per-agent. */
  sharedProcess: boolean;
}

export interface AgentResourcesInput extends AgentResourceRequest {
  agentId: string;
}

export type ControlSupport = { supported: true } | { supported: false; reason: string };

/** What this host can enforce. Assignable to the protocol's `AgentResourceCapabilities`. */
export interface HostCapabilities {
  backend: AgentResourceBackend;
  controls: Record<AgentResourceControl, ControlSupport>;
}

export interface AgentResourcesOptions {
  logger: Logger;
  /** Distinguishes this daemon's units from another daemon's on the same host. */
  namespace: string;
  host?: ResourceHost;
}

interface ControlFailure {
  state: "denied" | "failed";
  message: string;
}

interface ObservedResources {
  limits: CgroupLimits | null;
  niceValues: number[];
}

interface HostDetection {
  systemd: SystemdDetection;
  /** Any `nice`: GNU coreutils or BusyBox. */
  niceCommand: string | null;
}

interface AgentSlice {
  systemd: Systemd;
  unit: string;
  /** Null until systemd reports the cgroup; the unit still has to be stopped. */
  cgroupDir: string | null;
}

interface AgentBoundary {
  policy: AgentResourcePolicy;
  slice: AgentSlice | null;
  leases: number;
  /** The slice outlived its last lease because stopping it failed. */
  cleanupPending: boolean;
  /** Live processes spawned directly for the agent. */
  pids: Set<number>;
  /** True once a niceness was set for the agent, so clearing the policy restores it. */
  niceChanged: boolean;
  failures: Map<AgentResourceControl, ControlFailure>;
}

const MAX_NICE_PASSES = 3;
const UNBOUNDED_LEASE: AgentResourceLease = { launch: undefined, release: async () => {} };
const NO_PROCESS_MESSAGE = "No agent process is running; this applies when one starts";
const NEXT_START_MESSAGE =
  "The running agent was started without a resource boundary; reload the agent to apply this";
const SHARED_PROCESS_MESSAGE =
  "This provider serves several agents from one process, so a per-agent limit cannot be applied";
const NICE_DENIED_MESSAGE =
  "The daemon may not raise priority above its own (needs CAP_SYS_NICE or a higher RLIMIT_NICE)";
const NICE_RUNNING_DENIED_MESSAGE =
  "The kernel refused to raise the priority of the running processes; reload the agent to apply this";

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameValue(actual: number | number[] | null, wanted: number | number[]): boolean {
  return !Array.isArray(wanted) && actual === wanted;
}

/**
 * `allowedCpus` is a ceiling: the kernel may narrow it to the CPUs the parent has,
 * which still confines the agent. It falls back to the parent's CPUs, outside the
 * request, only when none of the requested ones is available.
 */
function cpusWithin(actual: number[] | null, wanted: readonly number[]): boolean {
  return actual !== null && actual.length > 0 && actual.every((cpu) => wanted.includes(cpu));
}

function failureFor(error: unknown): ControlFailure {
  return {
    state: isPermissionFailure(error) ? "denied" : "failed",
    message: errorMessage(error),
  };
}

/**
 * Owns the operating-system side of per-agent resource policies: one systemd slice
 * per agent where systemd and cgroup v2 are usable, niceness alone where they are
 * not. A policy the host cannot enforce is refused; what is in force is read back
 * from the host.
 */
export class AgentResources {
  private readonly logger: Logger;
  private readonly host: ResourceHost;
  private readonly unitPrefix: string;
  private readonly boundaries = new Map<string, AgentBoundary>();
  private readonly niceProbes = new Map<number, Promise<boolean>>();
  private detection: Promise<HostDetection> | null = null;
  private scopeSequence = 0;

  constructor(options: AgentResourcesOptions) {
    this.logger = options.logger.child({ module: "agent-resources" });
    this.host = options.host ?? createResourceHost();
    // Unit names are built only from hashes, never from caller-supplied text.
    this.unitPrefix = `paseo_${shortHash(options.namespace, 10)}`;
  }

  /** True when this host can enforce at least one control. */
  get supported(): boolean {
    return this.host.platform === "linux";
  }

  sliceFor(agentId: string): string {
    return `${this.unitPrefix}-agent_${shortHash(agentId, 16)}.slice`;
  }

  /** Removes boundaries a previous daemon of this home left behind after a crash. */
  async start(): Promise<void> {
    await this.stopRootSlice();
  }

  async shutdown(): Promise<void> {
    this.boundaries.clear();
    await this.stopRootSlice();
  }

  async capabilities(): Promise<HostCapabilities> {
    if (!this.supported) {
      const unsupported = { supported: false, reason: "Resource controls need a Linux host" };
      return {
        backend: "none",
        controls: {
          nice: unsupported,
          cpuWeight: unsupported,
          cpuQuotaPercent: unsupported,
          memoryHighMb: unsupported,
          memoryMaxMb: unsupported,
          allowedCpus: unsupported,
        },
      };
    }
    const { systemd, niceCommand } = await this.detect();
    const cgroupControl = (control: CgroupControl): ControlSupport => {
      if (!systemd.available) {
        return { supported: false, reason: `Needs systemd and cgroup v2: ${systemd.reason}` };
      }
      const controller = CONTROLLER_BY_CONTROL[control];
      if (!systemd.systemd.controllers.has(controller)) {
        return {
          supported: false,
          reason: `The ${controller} cgroup controller is not delegated to the systemd ${systemd.systemd.bus} manager`,
        };
      }
      return { supported: true };
    };
    const nice: ControlSupport = niceCommand
      ? { supported: true }
      : { supported: false, reason: "Needs the nice command" };
    let backend: AgentResourceBackend = "none";
    if (systemd.available) {
      backend = "systemd";
    } else if (niceCommand) {
      backend = "nice";
    }
    return {
      backend,
      controls: {
        nice,
        cpuWeight: cgroupControl("cpuWeight"),
        cpuQuotaPercent: cgroupControl("cpuQuotaPercent"),
        memoryHighMb: cgroupControl("memoryHighMb"),
        memoryMaxMb: cgroupControl("memoryMaxMb"),
        allowedCpus: cgroupControl("allowedCpus"),
      },
    };
  }

  /** Rejects a policy with a control this host or provider cannot enforce. */
  async assertEnforceable(request: AgentResourceRequest): Promise<void> {
    const refused = await this.unenforceable(request);
    if (refused.length > 0) {
      throw new UnenforceableAgentResourcePolicyError(refused);
    }
  }

  /**
   * Call before opening a provider session. Rejects when the policy cannot be
   * enforced or its slice cannot be created, so a provider never starts outside the
   * boundary its policy asks for.
   */
  async open(input: AgentResourcesInput): Promise<AgentResourceLease> {
    const policy = input.policy ?? {};
    await this.assertEnforceable({ policy, sharedProcess: input.sharedProcess });
    if (!this.supported || input.sharedProcess) {
      // The policy is empty here, and a later one would be refused: nothing to track.
      return UNBOUNDED_LEASE;
    }
    const detected = await this.detect();
    const boundary = await this.boundaryForOpen(input.agentId, policy);
    boundary.leases += 1;
    const lease = this.createLease(input.agentId, boundary, detected);
    if (isEmptyAgentResourcePolicy(policy) || boundary.slice || !detected.systemd.available) {
      return lease;
    }
    try {
      await this.createSlice(input.agentId, boundary, detected.systemd.systemd);
    } catch (error) {
      await lease.release();
      throw error;
    }
    return lease;
  }

  /**
   * Applies a changed policy to a running agent. A no-op when the agent is not open.
   * The caller has checked the policy with `assertEnforceable`.
   */
  async update(agentId: string, policy: AgentResourcePolicy | undefined): Promise<void> {
    const boundary = this.boundaries.get(agentId);
    if (!boundary || boundary.leases === 0) {
      return;
    }
    const previous = boundary.policy;
    // A removal the host refused is still in force, so it stays part of every later
    // attempt until one succeeds.
    const unresolved = new Set(boundary.failures.keys());
    boundary.policy = policy ?? {};
    boundary.failures.clear();
    if (boundary.slice) {
      const controls = this.supportedCgroupControls(boundary.slice.systemd);
      try {
        await boundary.slice.systemd.setSliceProperties({
          unit: boundary.slice.unit,
          policy: boundary.policy,
          controls,
        });
      } catch (error) {
        if (!(error instanceof ResourceHostCommandError)) {
          throw error;
        }
        this.logger.warn({ err: error, agentId }, "Failed to update agent resource limits");
        // The controls this change touched: set before or after it, or still unresolved.
        for (const control of controls) {
          const touched =
            previous[control] !== undefined ||
            boundary.policy[control] !== undefined ||
            unresolved.has(control);
          if (touched) {
            boundary.failures.set(control, failureFor(error));
          }
        }
      }
    }
    await this.applyNice(boundary);
  }

  /** What is in force for the agent, control by control, read back from the host. */
  async status(input: AgentResourcesInput): Promise<AgentResourceStatus> {
    const policy = input.policy ?? {};
    const { backend } = await this.capabilities();
    // A stored policy can outlive the host or provider that accepted it.
    const refused = new Map(
      (await this.unenforceable({ policy, sharedProcess: input.sharedProcess })).map((entry) => [
        entry.control,
        entry,
      ]),
    );
    const boundary = this.boundaries.get(input.agentId);
    const observed = await this.observe(boundary, policy);
    const controls: AgentResourceStatus["controls"] = {};
    for (const control of AGENT_RESOURCE_CONTROLS) {
      const refusal = refused.get(control);
      const entry = refusal
        ? { state: refusal.state, message: refusal.message }
        : this.controlStatus(control, policy, boundary, observed);
      if (entry) {
        controls[control] = entry;
      }
    }
    return {
      backend,
      active: boundary !== undefined && (boundary.slice !== null || boundary.pids.size > 0),
      unit: boundary?.slice?.unit ?? null,
      cgroup: boundary?.slice?.cgroupDir ?? null,
      controls,
    };
  }

  private async unenforceable(request: AgentResourceRequest): Promise<UnenforceableControl[]> {
    const policy = request.policy ?? {};
    if (isEmptyAgentResourcePolicy(policy)) {
      return [];
    }
    const capabilities = await this.capabilities();
    const refused: UnenforceableControl[] = [];
    for (const control of AGENT_RESOURCE_CONTROLS) {
      if (policy[control] === undefined) {
        continue;
      }
      const support = capabilities.controls[control];
      if (!support.supported) {
        refused.push({ control, state: "unsupported", message: support.reason });
      } else if (request.sharedProcess) {
        refused.push({ control, state: "unsupported", message: SHARED_PROCESS_MESSAGE });
      }
    }
    const isRefused = (control: AgentResourceControl) =>
      refused.some((entry) => entry.control === control);
    if (policy.nice !== undefined && !isRefused("nice") && !(await this.canStartAt(policy.nice))) {
      refused.push({ control: "nice", state: "denied", message: NICE_DENIED_MESSAGE });
    }
    if (policy.allowedCpus && !isRefused("allowedCpus")) {
      const message = await this.unavailableCpusMessage(policy.allowedCpus);
      if (message) {
        refused.push({ control: "allowedCpus", state: "unsupported", message });
      }
    }
    return refused;
  }

  private async unavailableCpusMessage(wanted: readonly number[]): Promise<string | null> {
    const { systemd } = await this.detect();
    if (!systemd.available) {
      return null;
    }
    const available = await systemd.systemd.readAvailableCpus();
    if (available === null || wanted.some((cpu) => available.includes(cpu))) {
      return null;
    }
    return `None of CPUs ${wanted.join(",")} is available to agents on this host (it has ${available.join(",")})`;
  }

  /**
   * Whether a process this daemon starts can run at `nice`. Lowering priority always
   * can. Raising it depends on RLIMIT_NICE and CAP_SYS_NICE, so it is tried: `nice`
   * without a command prints the niceness it ended up with. GNU `nice` carries on
   * when the kernel refuses the adjustment; BusyBox `nice` exits.
   */
  private async canStartAt(nice: number): Promise<boolean> {
    const daemonNice = this.host.getPriority(0);
    const { niceCommand } = await this.detect();
    if (nice >= daemonNice || !niceCommand) {
      return true;
    }
    let probe = this.niceProbes.get(nice);
    if (!probe) {
      probe = this.host
        .exec({ command: niceCommand, args: ["-n", String(nice - daemonNice), niceCommand] })
        .then(
          (output) => Number.parseInt(output, 10) === nice,
          (error: unknown) => {
            if (error instanceof ResourceHostCommandError) {
              return false;
            }
            throw error;
          },
        );
      this.niceProbes.set(nice, probe);
    }
    return probe;
  }

  private async observe(
    boundary: AgentBoundary | undefined,
    policy: AgentResourcePolicy,
  ): Promise<ObservedResources> {
    if (!boundary) {
      return { limits: null, niceValues: [] };
    }
    const cgroupDir = boundary.slice?.cgroupDir;
    const readsNice = policy.nice !== undefined || boundary.failures.has("nice");
    return {
      limits: cgroupDir ? await readCgroupLimits(this.host, cgroupDir) : null,
      niceValues: readsNice ? await this.readNiceValues(boundary) : [],
    };
  }

  private controlStatus(
    control: AgentResourceControl,
    policy: AgentResourcePolicy,
    boundary: AgentBoundary | undefined,
    observed: ObservedResources,
  ): AgentResourceControlStatus | undefined {
    const wanted = policy[control];
    if (wanted === undefined) {
      return boundary ? this.removalStatus(control, boundary, observed) : undefined;
    }
    if (!boundary || boundary.leases === 0) {
      return { state: "pending", message: NO_PROCESS_MESSAGE };
    }
    if (control === "nice") {
      return this.niceStatus(boundary, policy.nice ?? 0, observed.niceValues);
    }
    return this.cgroupStatus(boundary, control, wanted, observed.limits);
  }

  /** A limit the policy dropped but the host kept is still in force. */
  private removalStatus(
    control: AgentResourceControl,
    boundary: AgentBoundary,
    observed: ObservedResources,
  ): AgentResourceControlStatus | undefined {
    const failure = boundary.failures.get(control);
    if (!failure) {
      return undefined;
    }
    const actual =
      control === "nice" ? (observed.niceValues[0] ?? null) : (observed.limits?.[control] ?? null);
    return { ...failure, actual, message: `Removing this control failed: ${failure.message}` };
  }

  private async boundaryForOpen(
    agentId: string,
    policy: AgentResourcePolicy,
  ): Promise<AgentBoundary> {
    let boundary = this.boundaries.get(agentId);
    if (boundary?.cleanupPending && boundary.slice) {
      // The previous runtime's slice may still hold its processes. Reusing it would
      // put them in the new runtime's boundary, so it has to go first.
      const { unit } = boundary.slice;
      await this.stopSlice(agentId, boundary);
      if (boundary.cleanupPending) {
        throw new SystemdUnitError(unit, "the agent's previous slice could not be stopped");
      }
      boundary = undefined;
    }
    if (!boundary) {
      boundary = {
        policy,
        slice: null,
        leases: 0,
        cleanupPending: false,
        pids: new Set(),
        niceChanged: false,
        failures: new Map(),
      };
      this.boundaries.set(agentId, boundary);
    }
    boundary.policy = policy;
    return boundary;
  }

  private async createSlice(
    agentId: string,
    boundary: AgentBoundary,
    systemd: Systemd,
  ): Promise<void> {
    const unit = this.sliceFor(agentId);
    // Recorded before systemd confirms it, so a failure below still stops the unit.
    const slice: AgentSlice = { systemd, unit, cgroupDir: null };
    boundary.slice = slice;
    await systemd.startSlice({
      unit,
      description: `Paseo agent ${shortHash(agentId, 16)}`,
      policy: boundary.policy,
      controls: this.supportedCgroupControls(systemd),
    });
    const cgroupDir = await systemd.readUnitCgroupDir(unit);
    if (!cgroupDir) {
      throw new SystemdUnitError(unit, "systemd reported no cgroup for it");
    }
    slice.cgroupDir = cgroupDir;
    const wantedCpus = boundary.policy.allowedCpus;
    if (!wantedCpus) {
      return;
    }
    const { allowedCpus } = await readCgroupLimits(this.host, cgroupDir);
    if (!cpusWithin(allowedCpus, wantedCpus)) {
      throw new UnenforceableAgentResourcePolicyError([
        {
          control: "allowedCpus",
          state: "unsupported",
          message: `The host cannot confine the agent to CPUs ${wantedCpus.join(",")}; it would run on ${allowedCpus?.join(",") ?? "no CPUs"}`,
        },
      ]);
    }
  }

  private cgroupStatus(
    boundary: AgentBoundary,
    control: CgroupControl,
    wanted: number | number[],
    limits: CgroupLimits | null,
  ): AgentResourceControlStatus {
    if (!limits) {
      return {
        state: "pending",
        message: boundary.pids.size > 0 ? NEXT_START_MESSAGE : NO_PROCESS_MESSAGE,
      };
    }
    const actual = limits[control];
    const failure = boundary.failures.get(control);
    if (failure) {
      return { ...failure, actual };
    }
    const holds = Array.isArray(wanted)
      ? cpusWithin(limits.allowedCpus, wanted)
      : sameValue(actual, wanted);
    if (holds) {
      return { state: "applied", actual };
    }
    return { state: "failed", actual, message: "The host reports a different value" };
  }

  private niceStatus(
    boundary: AgentBoundary,
    wanted: number,
    values: number[],
  ): AgentResourceControlStatus {
    if (values.length === 0) {
      return { state: "pending", message: NO_PROCESS_MESSAGE };
    }
    // Applied only when every thread has it; otherwise show a thread that does not.
    const differing = values.find((value) => value !== wanted);
    if (differing === undefined) {
      return { state: "applied", actual: wanted };
    }
    const failure = boundary.failures.get("nice");
    if (failure) {
      return { ...failure, actual: differing };
    }
    return {
      state: "failed",
      actual: differing,
      message: "Some threads have a different niceness",
    };
  }

  private createLease(
    agentId: string,
    boundary: AgentBoundary,
    detected: HostDetection,
  ): AgentResourceLease {
    let released = false;
    return {
      launch: this.createLaunch(boundary, detected.niceCommand),
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        boundary.leases -= 1;
        if (boundary.leases > 0) {
          return;
        }
        await this.stopSlice(agentId, boundary);
      },
    };
  }

  /**
   * Stops the slice and forgets the boundary. Whatever the provider's own teardown
   * left running dies with the slice. When stopping fails the boundary stays
   * registered and marked, so the next open retries before reusing it.
   */
  private async stopSlice(agentId: string, boundary: AgentBoundary): Promise<void> {
    if (boundary.slice) {
      try {
        await boundary.slice.systemd.stopUnit(boundary.slice.unit);
      } catch (error) {
        if (!(error instanceof ResourceHostCommandError)) {
          throw error;
        }
        boundary.cleanupPending = true;
        this.logger.warn({ err: error, agentId }, "Failed to stop agent resource slice");
        return;
      }
    }
    boundary.cleanupPending = false;
    if (this.boundaries.get(agentId) === boundary) {
      this.boundaries.delete(agentId);
    }
  }

  private createLaunch(boundary: AgentBoundary, niceCommand: string | null): AgentResourceLaunch {
    return {
      wrap: (target) => {
        const launch = this.withNice(boundary, target, niceCommand);
        if (!boundary.slice) {
          return launch;
        }
        this.scopeSequence += 1;
        const stem = boundary.slice.unit.replace(/\.slice$/, "");
        return boundary.slice.systemd.scopedLaunch({
          slice: boundary.slice.unit,
          scope: `${stem}-p${process.pid}n${this.scopeSequence}.scope`,
          target: launch,
        });
      },
      attach: (child) => {
        const pid = child.pid;
        if (pid === undefined) {
          return;
        }
        boundary.pids.add(pid);
        child.once("exit", () => boundary.pids.delete(pid));
      },
    };
  }

  /**
   * Niceness is set before the provider runs any code, so every thread and child it
   * creates inherits it. `nice` adjusts relative to the niceness it starts with,
   * which is the daemon's. No `--` before the command: BusyBox would run it.
   */
  private withNice(
    boundary: AgentBoundary,
    target: ResourceLaunchTarget,
    niceCommand: string | null,
  ): ResourceLaunchTarget {
    const wanted = boundary.policy.nice;
    if (wanted === undefined || !niceCommand) {
      return target;
    }
    const adjustment = wanted - this.host.getPriority(0);
    if (adjustment === 0) {
      return target;
    }
    boundary.niceChanged = true;
    return {
      ...target,
      command: niceCommand,
      args: ["-n", String(adjustment), target.command, ...target.args],
    };
  }

  private setNice(boundary: AgentBoundary, tid: number, nice: number): void {
    try {
      if (this.host.getPriority(tid) === nice) {
        return;
      }
      this.host.setPriority(tid, nice);
      boundary.niceChanged = true;
    } catch (error) {
      if (errnoOf(error) === "ESRCH") {
        return;
      }
      boundary.failures.set(
        "nice",
        isPermissionFailure(error)
          ? { state: "denied", message: NICE_RUNNING_DENIED_MESSAGE }
          : { state: "failed", message: errorMessage(error) },
      );
    }
  }

  /**
   * Niceness belongs to a thread, and a new thread copies its creator's. Renice
   * every thread, then look again for ones created meanwhile from a stale value.
   */
  private async applyNice(boundary: AgentBoundary): Promise<void> {
    let target = boundary.policy.nice;
    if (target === undefined) {
      if (!boundary.niceChanged) {
        return;
      }
      target = this.host.getPriority(0);
    }
    for (let pass = 0; pass < MAX_NICE_PASSES; pass += 1) {
      const changedBefore = boundary.niceChanged;
      boundary.niceChanged = false;
      for (const tid of await this.listThreads(boundary)) {
        this.setNice(boundary, tid, target);
      }
      const changed = boundary.niceChanged;
      boundary.niceChanged = changedBefore || changed;
      if (!changed) {
        return;
      }
    }
  }

  private async readNiceValues(boundary: AgentBoundary): Promise<number[]> {
    const values: number[] = [];
    for (const tid of await this.listThreads(boundary)) {
      try {
        values.push(this.host.getPriority(tid));
      } catch (error) {
        // The thread exited between listing and reading.
        if (errnoOf(error) !== "ESRCH") {
          throw error;
        }
      }
    }
    return values;
  }

  private listThreads(boundary: AgentBoundary): Promise<number[]> {
    return boundary.slice?.cgroupDir
      ? listCgroupThreads(this.host, boundary.slice.cgroupDir)
      : listProcessTreeThreads(this.host, boundary.pids);
  }

  private supportedCgroupControls(systemd: Systemd): CgroupControl[] {
    return CGROUP_CONTROLS.filter((control) =>
      systemd.controllers.has(CONTROLLER_BY_CONTROL[control]),
    );
  }

  private detect(): Promise<HostDetection> {
    this.detection ??= this.runDetection();
    return this.detection;
  }

  private async runDetection(): Promise<HostDetection> {
    const [systemd, niceCommand] = await Promise.all([
      detectSystemd(this.host),
      this.host.findExecutable("nice"),
    ]);
    this.logger.info(
      {
        ...(systemd.available
          ? { bus: systemd.systemd.bus, controllers: [...systemd.systemd.controllers] }
          : { reason: systemd.reason }),
        nice: niceCommand,
      },
      systemd.available
        ? "Agent resource controls use systemd"
        : "Agent resource controls are limited to niceness",
    );
    return { systemd, niceCommand };
  }

  private async stopRootSlice(): Promise<void> {
    if (!this.supported) {
      return;
    }
    const { systemd } = await this.detect();
    if (!systemd.available) {
      return;
    }
    try {
      // Every agent slice of this daemon sits under `<prefix>.slice`.
      await systemd.systemd.stopUnit(`${this.unitPrefix}.slice`);
    } catch (error) {
      if (!(error instanceof ResourceHostCommandError)) {
        throw error;
      }
      this.logger.warn({ err: error }, "Failed to stop the agent resource root slice");
    }
  }
}
