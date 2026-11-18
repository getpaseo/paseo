import type { Command } from "commander";
import {
  AGENT_RESOURCE_CONTROLS,
  AgentResourcePolicySchema,
  describeInvalidAgentResourcePolicy,
  isEmptyAgentResourcePolicy,
  type AgentResourceControl,
  type AgentResourcePolicy,
  type AgentResourceStatus,
} from "@getpaseo/protocol/agent-resources";
import type { CommandError } from "../output/index.js";

/** The raw `--nice`, `--cpu-*`, `--memory-*` and `--cpus` values commander collects. */
export interface ResourceOptions {
  nice?: string;
  cpuWeight?: string;
  cpuQuota?: string;
  memoryHigh?: string;
  memoryMax?: string;
  cpus?: string;
}

const FLAG_BY_CONTROL: Record<AgentResourceControl, { flag: string; key: keyof ResourceOptions }> =
  {
    nice: { flag: "--nice", key: "nice" },
    cpuWeight: { flag: "--cpu-weight", key: "cpuWeight" },
    cpuQuotaPercent: { flag: "--cpu-quota", key: "cpuQuota" },
    memoryHighMb: { flag: "--memory-high", key: "memoryHigh" },
    memoryMaxMb: { flag: "--memory-max", key: "memoryMax" },
    allowedCpus: { flag: "--cpus", key: "cpus" },
  };

const CLEAR = "none";
const MAX_CPU_INDEX = 1023;

/**
 * Adds the resource flags. `clearable` lets each one take `none`, which removes
 * that control from a stored policy.
 */
export function addResourceOptions(cmd: Command, options?: { clearable?: boolean }): Command {
  const none = options?.clearable ? ', or "none" to remove it' : "";
  return cmd
    .option("--nice <n>", `Linux scheduling niceness, -20 to 19${none}`)
    .option("--cpu-weight <n>", `Relative CPU share under contention, 1 to 10000${none}`)
    .option("--cpu-quota <percent>", `CPU ceiling in percent of one CPU, e.g. 150${none}`)
    .option("--memory-high <MiB>", `Memory throttling threshold in MiB${none}`)
    .option("--memory-max <MiB>", `Hard memory limit in MiB; exceeding it kills processes${none}`)
    .option("--cpus <list>", `CPUs the agent may run on, e.g. 0-3,6${none}`);
}

function invalid(message: string, details?: string): CommandError {
  return { code: "INVALID_RESOURCE_POLICY", message, ...(details ? { details } : {}) };
}

function parseCpuList(flag: string, value: string): number[] {
  const cpus: number[] = [];
  for (const part of value.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) {
      throw invalid(`${flag} must be a CPU list such as 0-3,6`, `Got "${value}"`);
    }
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    // Checked before expanding, so a huge range cannot exhaust memory.
    if (last > MAX_CPU_INDEX) {
      throw invalid(`${flag} CPUs must be between 0 and ${MAX_CPU_INDEX}`, `Got "${value}"`);
    }
    if (last < first) {
      throw invalid(`${flag} has a descending range: ${part.trim()}`);
    }
    // Repeated ranges could still add up to far more CPUs than exist.
    if (cpus.length + (last - first + 1) > MAX_CPU_INDEX + 1) {
      throw invalid(`${flag} lists more than ${MAX_CPU_INDEX + 1} CPUs`, `Got "${value}"`);
    }
    for (let cpu = first; cpu <= last; cpu += 1) {
      cpus.push(cpu);
    }
  }
  return cpus;
}

function parseValue(control: AgentResourceControl, raw: string): number | number[] {
  const { flag } = FLAG_BY_CONTROL[control];
  if (control === "allowedCpus") {
    return parseCpuList(flag, raw);
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    throw invalid(`${flag} must be a whole number`, `Got "${raw}"`);
  }
  return Number(raw.trim());
}

function validate(policy: AgentResourcePolicy): AgentResourcePolicy {
  const parsed = AgentResourcePolicySchema.safeParse(policy);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const control = issue?.path[0] as AgentResourceControl | undefined;
    const flag = control ? FLAG_BY_CONTROL[control]?.flag : undefined;
    throw invalid(`${flag ?? "Resource policy"}: ${issue?.message ?? "invalid value"}`);
  }
  const reason = describeInvalidAgentResourcePolicy(parsed.data);
  if (reason) {
    throw invalid(
      reason.replace("memoryHighMb", "--memory-high").replace("memoryMaxMb", "--memory-max"),
    );
  }
  return parsed.data;
}

/** A policy for a new agent or schedule, or undefined when no flag was given. */
export function parseResourcePolicy(options: ResourceOptions): AgentResourcePolicy | undefined {
  const policy: Record<string, number | number[]> = {};
  for (const control of AGENT_RESOURCE_CONTROLS) {
    const raw = options[FLAG_BY_CONTROL[control].key];
    if (raw !== undefined) {
      policy[control] = parseValue(control, raw);
    }
  }
  return Object.keys(policy).length > 0 ? validate(policy) : undefined;
}

/** Per-control changes; `null` removes the control. Undefined when no flag was given. */
export type ResourcePolicyPatch = Partial<Record<AgentResourceControl, number | number[] | null>>;

export function parseResourcePatch(options: ResourceOptions): ResourcePolicyPatch | undefined {
  const patch: ResourcePolicyPatch = {};
  for (const control of AGENT_RESOURCE_CONTROLS) {
    const raw = options[FLAG_BY_CONTROL[control].key];
    if (raw === undefined) {
      continue;
    }
    patch[control] = raw.trim().toLowerCase() === CLEAR ? null : parseValue(control, raw);
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Applies a patch to a stored policy. `null` means the result has no limits at all. */
export function applyResourcePatch(
  current: AgentResourcePolicy | null | undefined,
  patch: ResourcePolicyPatch,
): AgentResourcePolicy | null {
  const next: Record<string, unknown> = { ...current };
  for (const [control, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[control];
    } else {
      next[control] = value;
    }
  }
  const policy = validate(next as AgentResourcePolicy);
  return isEmptyAgentResourcePolicy(policy) ? null : policy;
}

function formatCpus(cpus: readonly number[]): string {
  const sorted = [...cpus].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  for (let index = 1; index <= sorted.length; index += 1) {
    if (sorted[index] !== sorted[index - 1] + 1) {
      const end = sorted[index - 1];
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = sorted[index];
    }
  }
  return ranges.join(",");
}

export function formatResourceValue(
  control: AgentResourceControl,
  value: number | number[],
): string {
  if (Array.isArray(value)) {
    return formatCpus(value);
  }
  switch (control) {
    case "cpuQuotaPercent":
      return `${value}%`;
    case "memoryHighMb":
    case "memoryMaxMb":
      return `${value} MiB`;
    default:
      return String(value);
  }
}

export function formatResourcePolicy(policy: AgentResourcePolicy | null | undefined): string {
  if (!policy || isEmptyAgentResourcePolicy(policy)) {
    return "-";
  }
  return AGENT_RESOURCE_CONTROLS.flatMap((control) => {
    const value = policy[control];
    return value === undefined
      ? []
      : [`${FLAG_BY_CONTROL[control].flag.slice(2)}=${formatResourceValue(control, value)}`];
  }).join(" ");
}

/** One line per configured control: what is stored, and whether it is in force. */
export function formatResourceStatus(
  policy: AgentResourcePolicy | null | undefined,
  status: AgentResourceStatus | null | undefined,
): string {
  const parts = AGENT_RESOURCE_CONTROLS.flatMap((control) => {
    const value = policy?.[control];
    if (value === undefined) {
      // The host kept a limit the policy no longer sets.
      const entry = status?.controls[control];
      return entry
        ? [
            `${FLAG_BY_CONTROL[control].flag.slice(2)}=none (${entry.state}: ${entry.message ?? ""})`,
          ]
        : [];
    }
    const entry = status?.controls[control];
    const label = `${FLAG_BY_CONTROL[control].flag.slice(2)}=${formatResourceValue(control, value)}`;
    if (!entry) {
      return [label];
    }
    const detail = entry.message ? `: ${entry.message}` : "";
    return [`${label} (${entry.state}${detail})`];
  }).join("; ");
  return parts || "-";
}

export function isCommandError(error: unknown): error is CommandError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error
  );
}
