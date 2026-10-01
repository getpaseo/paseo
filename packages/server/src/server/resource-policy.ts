import type { ResourcePolicy } from "@getpaseo/protocol/messages";

export interface ResourcePolicyLimits {
  allowAutomatedLoops: boolean;
  maxStatusReadsPerRun: number;
  maxStatusReadsPerWindow: number;
  maxPollingDurationMs: number;
  statusDedupWindowMs: number;
  statusWindowMs: number;
}

export const RESOURCE_POLICY_LIMITS: Record<ResourcePolicy, ResourcePolicyLimits> = {
  economy: {
    allowAutomatedLoops: false,
    maxStatusReadsPerRun: 1,
    maxStatusReadsPerWindow: 1,
    maxPollingDurationMs: 0,
    statusDedupWindowMs: 5_000,
    statusWindowMs: 30_000,
  },
  balanced: {
    allowAutomatedLoops: true,
    maxStatusReadsPerRun: 4,
    maxStatusReadsPerWindow: 20,
    maxPollingDurationMs: 30_000,
    statusDedupWindowMs: 1_000,
    statusWindowMs: 10_000,
  },
  deep: {
    allowAutomatedLoops: true,
    maxStatusReadsPerRun: 12,
    maxStatusReadsPerWindow: 60,
    maxPollingDurationMs: 120_000,
    statusDedupWindowMs: 250,
    statusWindowMs: 10_000,
  },
};

export function resolveResourcePolicy(policy: ResourcePolicy | undefined): ResourcePolicy {
  return policy ?? "balanced";
}

const RESOURCE_POLICY_PROMPTS: Record<ResourcePolicy, string> = {
  economy:
    "Paseo resource policy (economy): for a standalone status-only request, perform at most one status read per run and answer. Avoid redundant reads and tight polling; do not start permanent watchers, automated loops or schedules. Prefer completion events. Keep waiting bounded and do not request xhigh reasoning implicitly.",
  balanced:
    "Paseo resource policy (balanced): for a standalone status-only request, use bounded status checks only when needed, at most four reads per run within 30 seconds. Automated loops and schedules may run, but avoid unchanged repeats, indefinite polling, and implicit xhigh reasoning.",
  deep: "Paseo resource policy (deep): for a standalone status-only request, use up to twelve status reads per run within 120 seconds when they provide useful progress. Automated loops and schedules may run, but keep them bounded, avoid unchanged repeats, and never poll indefinitely or request xhigh reasoning implicitly.",
};

export function buildResourcePolicyPrompt(policy: ResourcePolicy): string {
  return `${RESOURCE_POLICY_PROMPTS[policy]}\n\nResource budgets limit redundant observation, not task completion. For an already-authorized task, keep working until the requested outcome is verified or a concrete blocker requires user input. Pending CI, reviews, builds, and delegated work are waiting phases, not completed tasks or reasons to ask the user to continue. Prefer completion events; otherwise use bounded waits and necessary checks after meaningful state changes. Before yielding while work is pending, ensure automatic continuation is registered; a status note alone does not resume the task. Never silently abandon required follow-up.`;
}

export interface ResourcePolicyStatusReadInput {
  consumerId: string;
  requestKey: string;
  runKey?: string;
}

export interface ResourcePolicyStatusReadDecision {
  allowed: boolean;
  deduplicated: boolean;
  policy: ResourcePolicy;
  reason?: string;
}

export interface ResourcePolicyAutomationDecision {
  allowed: boolean;
  policy: ResourcePolicy;
  reason?: string;
}

interface StatusReadState {
  count: number;
  lastRequestAt: number;
  lastRequestKey: string;
  runKey?: string;
  startedAt: number;
  windowStartedAt: number;
}

export class ResourcePolicyRuntime {
  private readonly statusReadStates = new Map<string, StatusReadState>();
  private readonly getPolicy: () => ResourcePolicy;
  private readonly now: () => number;

  constructor(options: { getPolicy: () => ResourcePolicy; now?: () => number }) {
    this.getPolicy = options.getPolicy;
    this.now = options.now ?? Date.now;
  }

  getPolicyValue(): ResourcePolicy {
    return this.getPolicy();
  }

  getLimits(): ResourcePolicyLimits {
    return RESOURCE_POLICY_LIMITS[this.getPolicy()];
  }

  checkStatusRead(input: ResourcePolicyStatusReadInput): ResourcePolicyStatusReadDecision {
    const policy = this.getPolicy();
    const limits = RESOURCE_POLICY_LIMITS[policy];
    const now = this.now();
    const stateKey = `${input.consumerId}:${input.runKey ?? "window"}`;
    const previous = this.statusReadStates.get(stateKey);

    if (
      previous &&
      previous.lastRequestKey === input.requestKey &&
      now - previous.lastRequestAt < limits.statusDedupWindowMs
    ) {
      return { allowed: true, deduplicated: true, policy };
    }

    const state = this.resolveState(previous, input, now, limits.statusWindowMs);
    if (input.runKey) {
      if (limits.maxPollingDurationMs > 0 && now - state.startedAt >= limits.maxPollingDurationMs) {
        return {
          allowed: false,
          deduplicated: false,
          policy,
          reason: `Resource policy '${policy}' limits status polling to ${limits.maxPollingDurationMs / 1000}s per run. Wait for the next run or choose a less restrictive policy.`,
        };
      }
      if (state.count >= limits.maxStatusReadsPerRun) {
        return {
          allowed: false,
          deduplicated: false,
          policy,
          reason:
            policy === "economy"
              ? "Automated status polling is disabled by the economy resource policy after one status read. Wait for an event notification or choose a less restrictive policy."
              : `Resource policy '${policy}' allows at most ${limits.maxStatusReadsPerRun} status reads per run. Wait for the next run or choose a less restrictive policy.`,
        };
      }
    } else if (state.count >= limits.maxStatusReadsPerWindow) {
      return {
        allowed: false,
        deduplicated: false,
        policy,
        reason: `Resource policy '${policy}' allows at most ${limits.maxStatusReadsPerWindow} status reads per ${limits.statusWindowMs / 1000}s window. Wait before trying again or choose a less restrictive policy.`,
      };
    }

    this.statusReadStates.set(stateKey, {
      ...state,
      count: state.count + 1,
      lastRequestAt: now,
      lastRequestKey: input.requestKey,
    });
    return { allowed: true, deduplicated: false, policy };
  }

  canStartAutomatedLoop(kind: string): ResourcePolicyAutomationDecision {
    const policy = this.getPolicy();
    if (RESOURCE_POLICY_LIMITS[policy].allowAutomatedLoops) {
      return { allowed: true, policy };
    }

    return {
      allowed: false,
      policy,
      reason: `Automated ${kind} is disabled by the economy resource policy. Run it manually or choose a less restrictive policy.`,
    };
  }

  private resolveState(
    previous: StatusReadState | undefined,
    input: ResourcePolicyStatusReadInput,
    now: number,
    statusWindowMs: number,
  ): StatusReadState {
    if (
      !previous ||
      (input.runKey === undefined && now - previous.windowStartedAt >= statusWindowMs)
    ) {
      return {
        count: 0,
        lastRequestAt: 0,
        lastRequestKey: "",
        ...(input.runKey ? { runKey: input.runKey } : {}),
        startedAt: now,
        windowStartedAt: now,
      };
    }

    return previous;
  }
}
