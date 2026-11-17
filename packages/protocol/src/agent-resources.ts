import { z } from "zod";

/**
 * Per-agent resource policy. Every field is optional and an absent field means
 * "leave the host default alone". The ranges are the ones Linux and systemd accept;
 * see docs/agent-resources.md for what each control does and where it is enforced.
 */
export const AgentResourcePolicySchema = z.object({
  /** Scheduling niceness, -20 (highest priority) to 19 (lowest). */
  nice: z.number().int().min(-20).max(19).optional(),
  /** cgroup v2 `cpu.weight`, 1 to 10000 (default 100). Relative share under contention. */
  cpuWeight: z.number().int().min(1).max(10000).optional(),
  /** Hard CPU ceiling as a percentage of one logical CPU: 100 is one full CPU, 250 is 2.5. */
  cpuQuotaPercent: z.number().int().min(1).max(102400).optional(),
  /** `memory.high` in MiB: above it the agent is throttled and reclaimed, not killed. */
  memoryHighMb: z.number().int().min(16).max(16777216).optional(),
  /** `memory.max` in MiB: a hard limit. Exceeding it invokes the OOM killer inside the agent. */
  memoryMaxMb: z.number().int().min(16).max(16777216).optional(),
  /** Logical CPU indices the agent may run on. */
  allowedCpus: z.array(z.number().int().min(0).max(1023)).min(1).max(1024).optional(),
});

export type AgentResourcePolicy = z.infer<typeof AgentResourcePolicySchema>;

export const AGENT_RESOURCE_CONTROLS = [
  "nice",
  "cpuWeight",
  "cpuQuotaPercent",
  "memoryHighMb",
  "memoryMaxMb",
  "allowedCpus",
] as const satisfies readonly (keyof AgentResourcePolicy)[];

export type AgentResourceControl = (typeof AGENT_RESOURCE_CONTROLS)[number];

/** `systemd`: a cgroup per agent. `nice`: priority only. `none`: nothing can be applied. */
const AgentResourceBackendSchema = z.enum(["systemd", "nice", "none"]);
export type AgentResourceBackend = z.infer<typeof AgentResourceBackendSchema>;

const AgentResourceControlCapabilitySchema = z.object({
  supported: z.boolean(),
  /** Why the host cannot apply this control. Present when `supported` is false. */
  reason: z.string().optional(),
});

export const AgentResourceCapabilitiesSchema = z.object({
  backend: AgentResourceBackendSchema,
  controls: z.object({
    nice: AgentResourceControlCapabilitySchema,
    cpuWeight: AgentResourceControlCapabilitySchema,
    cpuQuotaPercent: AgentResourceControlCapabilitySchema,
    memoryHighMb: AgentResourceControlCapabilitySchema,
    memoryMaxMb: AgentResourceControlCapabilitySchema,
    allowedCpus: AgentResourceControlCapabilitySchema,
  }),
});

export type AgentResourceCapabilities = z.infer<typeof AgentResourceCapabilitiesSchema>;

/**
 * - `applied`: the running agent has the configured value.
 * - `pending`: stored, and takes effect the next time the agent's runtime starts.
 * - `unsupported`: this host or provider can no longer apply a stored control.
 * - `denied`: the host refused the change for lack of privilege.
 * - `failed`: applying it failed for another reason.
 */
const AgentResourceControlStateSchema = z.enum([
  "applied",
  "pending",
  "unsupported",
  "denied",
  "failed",
]);
export type AgentResourceControlState = z.infer<typeof AgentResourceControlStateSchema>;

const AgentResourceControlStatusSchema = z.object({
  state: AgentResourceControlStateSchema,
  /** What the host reports for the running agent; `null` when it reports no limit. */
  actual: z
    .union([z.number(), z.array(z.number())])
    .nullable()
    .optional(),
  message: z.string().optional(),
});

export type AgentResourceControlStatus = z.infer<typeof AgentResourceControlStatusSchema>;

/** What is in force for one agent right now, as opposed to its stored policy. */
export const AgentResourceStatusSchema = z.object({
  backend: AgentResourceBackendSchema,
  /** True while the agent has a resource boundary on the host. */
  active: z.boolean(),
  /** systemd slice holding the agent's processes. */
  unit: z.string().nullable(),
  /** The slice's cgroup path under /sys/fs/cgroup. */
  cgroup: z.string().nullable(),
  /** One entry per control the policy configures. */
  controls: z.object({
    nice: AgentResourceControlStatusSchema.optional(),
    cpuWeight: AgentResourceControlStatusSchema.optional(),
    cpuQuotaPercent: AgentResourceControlStatusSchema.optional(),
    memoryHighMb: AgentResourceControlStatusSchema.optional(),
    memoryMaxMb: AgentResourceControlStatusSchema.optional(),
    allowedCpus: AgentResourceControlStatusSchema.optional(),
  }),
});

export type AgentResourceStatus = z.infer<typeof AgentResourceStatusSchema>;

export function isEmptyAgentResourcePolicy(
  policy: AgentResourcePolicy | null | undefined,
): boolean {
  if (!policy) {
    return true;
  }
  return AGENT_RESOURCE_CONTROLS.every((control) => policy[control] === undefined);
}

/**
 * Cross-field rules the structural schema cannot express. Returns the reason the
 * policy is invalid, or null.
 */
export function describeInvalidAgentResourcePolicy(policy: AgentResourcePolicy): string | null {
  if (
    policy.memoryHighMb !== undefined &&
    policy.memoryMaxMb !== undefined &&
    policy.memoryHighMb > policy.memoryMaxMb
  ) {
    return "memoryHighMb must not exceed memoryMaxMb";
  }
  if (policy.allowedCpus && new Set(policy.allowedCpus).size !== policy.allowedCpus.length) {
    return "allowedCpus must not repeat a CPU";
  }
  return null;
}
