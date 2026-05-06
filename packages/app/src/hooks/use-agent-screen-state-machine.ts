import { useRef } from "react";

export interface AgentScreenAgent {
  serverId: string;
  id: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  cwd: string;
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
  placeholderAgent: AgentScreenAgent | null;
  missingAgentState: AgentScreenMissingState;
  isConnected: boolean;
  isArchivingCurrentAgent: boolean;
  isHistorySyncing: boolean;
  needsAuthoritativeSync: boolean;
  shouldUseOptimisticStream: boolean;
  hasHydratedHistoryBefore: boolean;
}

function shouldBlockInitialAuthoritativeReadyState(input: AgentScreenMachineInput): boolean {
  return (
    !input.shouldUseOptimisticStream &&
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
    input.shouldUseOptimisticStream &&
    Boolean(input.placeholderAgent) &&
    (!input.agent || input.agent.status === "initializing" || input.agent.status === "idle")
  );
}

function resolveCandidateAgent(args: {
  input: AgentScreenMachineInput;
  useOptimisticCreateFlowAgent: boolean;
}): AgentScreenAgent | null {
  const { input, useOptimisticCreateFlowAgent } = args;
  if (input.agent && useOptimisticCreateFlowAgent && input.placeholderAgent) {
    return { ...input.agent, status: input.placeholderAgent.status };
  }
  return input.agent ?? input.placeholderAgent;
}

function resolveAgentScreenSource(args: {
  useOptimisticCreateFlowAgent: boolean;
  hasAgent: boolean;
  shouldUseOptimisticStream: boolean;
}): "authoritative" | "optimistic" | "stale" {
  if (args.useOptimisticCreateFlowAgent) return "optimistic";
  if (args.hasAgent) return "authoritative";
  if (args.shouldUseOptimisticStream) return "optimistic";
  return "stale";
}

function resolveCatchingUpUi(args: {
  shouldUseOptimisticStream: boolean;
  hasHydratedHistoryBefore: boolean;
  hadInitialSyncFailure: boolean;
}): "overlay" | "silent" {
  if (args.shouldUseOptimisticStream) return "silent";
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
        shouldUseOptimisticStream: input.shouldUseOptimisticStream,
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
    shouldUseOptimisticStream: input.shouldUseOptimisticStream,
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
