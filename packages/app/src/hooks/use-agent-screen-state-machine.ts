import { useRef } from "react";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";

export interface AgentScreenAgent {
  serverId: string;
  id: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  cwd: string;
  workspaceId?: string;
  capabilities?: AgentCapabilityFlags;
  lastError?: string | null;
  projectPlacement?: {
    checkout?: {
      cwd?: string;
      isGit?: boolean;
    };
  } | null;
}

export type AgentScreenMissingState =
  | { kind: "idle" }
  | { kind: "resolving" }
  | { kind: "not_found"; message: string }
  | { kind: "error"; message: string };

export interface AgentScreenMachineInput {
  agent: AgentScreenAgent | null;
  missingAgentState: AgentScreenMissingState;
  isConnected: boolean;
  isArchivingCurrentAgent: boolean;
  isHistorySyncing: boolean;
  needsAuthoritativeSync: boolean;
  continuity: AgentScreenContinuity;
  hasHydratedHistoryBefore: boolean;
}

export type AgentScreenContinuity =
  | { kind: "none" }
  | { kind: "optimistic-create"; agent: AgentScreenAgent };

function hasOptimisticCreateContinuity(input: AgentScreenMachineInput): boolean {
  return input.continuity.kind === "optimistic-create";
}

function shouldBlockInitialAuthoritativeReadyState(input: AgentScreenMachineInput): boolean {
  return (
    !hasOptimisticCreateContinuity(input) &&
    !input.hasHydratedHistoryBefore &&
    (input.needsAuthoritativeSync || input.isHistorySyncing)
  );
}

export interface AgentScreenMachineMemory {
  hasRenderedReady: boolean;
  lastReadyAgent: AgentScreenAgent | null;
  hadInitialSyncFailure: boolean;
}

export type AgentScreenReadySyncState =
  | { status: "idle" }
  | { status: "reconnecting" }
  | {
      status: "catching_up";
      ui: "overlay" | "silent";
    }
  | { status: "sync_error" };

export type AgentScreenViewState =
  | {
      tag: "boot";
      reason: "loading" | "resolving";
      source: "none";
    }
  | {
      tag: "not_found";
      message: string;
    }
  | {
      tag: "error";
      message: string;
    }
  | {
      tag: "ready";
      agent: AgentScreenAgent;
      source: "authoritative" | "optimistic" | "stale";
      sync: AgentScreenReadySyncState;
      isArchiving: boolean;
    };

function updateInitialSyncFailureMemory(args: {
  input: AgentScreenMachineInput;
  nextMemory: AgentScreenMachineMemory;
}): void {
  if (args.input.hasHydratedHistoryBefore) {
    args.nextMemory.hadInitialSyncFailure = false;
  }
  if (args.input.missingAgentState.kind === "error" && !args.input.hasHydratedHistoryBefore) {
    args.nextMemory.hadInitialSyncFailure = true;
  }
}

function shouldUseOptimisticCreateFlowAgent(input: AgentScreenMachineInput): boolean {
  return (
    input.continuity.kind === "optimistic-create" && (!input.agent || input.agent.status === "idle")
  );
}

function resolveCandidateAgent(args: {
  input: AgentScreenMachineInput;
  useOptimisticCreateFlowAgent: boolean;
}): AgentScreenAgent | null {
  const { input, useOptimisticCreateFlowAgent } = args;
  const continuityAgent =
    input.continuity.kind === "optimistic-create" ? input.continuity.agent : null;
  if (input.agent && useOptimisticCreateFlowAgent && continuityAgent) {
    return { ...input.agent, status: continuityAgent.status };
  }
  return input.agent ?? continuityAgent;
}

function resolveAgentScreenSource(args: {
  useOptimisticCreateFlowAgent: boolean;
  hasAgent: boolean;
  hasOptimisticCreateContinuity: boolean;
}): "authoritative" | "optimistic" | "stale" {
  if (args.useOptimisticCreateFlowAgent) return "optimistic";
  if (args.hasAgent) return "authoritative";
  if (args.hasOptimisticCreateContinuity) return "optimistic";
  return "stale";
}

function resolveCatchingUpUi(args: {
  hasOptimisticCreateContinuity: boolean;
  hasHydratedHistoryBefore: boolean;
  hadInitialSyncFailure: boolean;
}): "overlay" | "silent" {
  if (args.hasOptimisticCreateContinuity) return "silent";
  if (args.hasHydratedHistoryBefore) return "silent";
  if (args.hadInitialSyncFailure) return "silent";
  return "overlay";
}

function resolveAgentScreenSync(args: {
  input: AgentScreenMachineInput;
  hadInitialSyncFailure: boolean;
}): AgentScreenReadySyncState {
  const { input, hadInitialSyncFailure } = args;
  if (!input.isConnected) {
    return { status: "reconnecting" };
  }
  if (input.missingAgentState.kind === "error") {
    return { status: "sync_error" };
  }
  if (input.needsAuthoritativeSync || input.isHistorySyncing) {
    return {
      status: "catching_up",
      ui: resolveCatchingUpUi({
        hasOptimisticCreateContinuity: hasOptimisticCreateContinuity(input),
        hasHydratedHistoryBefore: input.hasHydratedHistoryBefore,
        hadInitialSyncFailure,
      }),
    };
  }
  return { status: "idle" };
}

export function deriveAgentScreenViewState({
  input,
  memory,
}: {
  input: AgentScreenMachineInput;
  memory: AgentScreenMachineMemory;
}): { state: AgentScreenViewState; memory: AgentScreenMachineMemory } {
  const nextMemory: AgentScreenMachineMemory = {
    hasRenderedReady: memory.hasRenderedReady,
    lastReadyAgent: memory.lastReadyAgent,
    hadInitialSyncFailure: memory.hadInitialSyncFailure,
  };

  updateInitialSyncFailureMemory({ input, nextMemory });

  const useOptimisticCreateFlowAgent = shouldUseOptimisticCreateFlowAgent(input);
  const candidateAgent = resolveCandidateAgent({ input, useOptimisticCreateFlowAgent });
  const shouldBlockReadyState = shouldBlockInitialAuthoritativeReadyState(input);

  if (input.missingAgentState.kind === "not_found") {
    return {
      state: {
        tag: "not_found",
        message: input.missingAgentState.message,
      },
      memory: nextMemory,
    };
  }

  if (input.missingAgentState.kind === "error" && !nextMemory.hasRenderedReady) {
    return {
      state: {
        tag: "error",
        message: input.missingAgentState.message,
      },
      memory: nextMemory,
    };
  }

  if (candidateAgent && shouldBlockReadyState) {
    return {
      state: {
        tag: "boot",
        reason: "loading",
        source: "none",
      },
      memory: nextMemory,
    };
  }

  if (candidateAgent) {
    nextMemory.hasRenderedReady = true;
    nextMemory.lastReadyAgent = candidateAgent;
  }

  const displayAgent =
    candidateAgent ?? (nextMemory.hasRenderedReady ? nextMemory.lastReadyAgent : null);
  if (!displayAgent) {
    return {
      state: {
        tag: "boot",
        reason: input.missingAgentState.kind === "resolving" ? "resolving" : "loading",
        source: "none",
      },
      memory: nextMemory,
    };
  }

  const source = resolveAgentScreenSource({
    useOptimisticCreateFlowAgent,
    hasAgent: Boolean(input.agent),
    hasOptimisticCreateContinuity: hasOptimisticCreateContinuity(input),
  });

  const sync = resolveAgentScreenSync({
    input,
    hadInitialSyncFailure: nextMemory.hadInitialSyncFailure,
  });

  return {
    state: {
      tag: "ready",
      agent: displayAgent,
      source,
      sync,
      isArchiving: input.isArchivingCurrentAgent,
    },
    memory: nextMemory,
  };
}

export function useAgentScreenStateMachine({
  routeKey,
  input,
}: {
  routeKey: string;
  input: AgentScreenMachineInput;
}): AgentScreenViewState {
  const routeKeyRef = useRef(routeKey);
  const memoryRef = useRef<AgentScreenMachineMemory>({
    hasRenderedReady: false,
    lastReadyAgent: null,
    hadInitialSyncFailure: false,
  });

  if (routeKeyRef.current !== routeKey) {
    routeKeyRef.current = routeKey;
    memoryRef.current = {
      hasRenderedReady: false,
      lastReadyAgent: null,
      hadInitialSyncFailure: false,
    };
  }

  const result = deriveAgentScreenViewState({
    input,
    memory: memoryRef.current,
  });
  memoryRef.current = result.memory;
  return result.state;
}
