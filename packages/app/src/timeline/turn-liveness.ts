import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

export interface TurnLivenessEvidence {
  epoch: string;
  seq: number;
}

export type TurnLiveness =
  | { phase: "idle" }
  | {
      phase: "open";
      startedAt: Date | null;
      evidence: TurnLivenessEvidence | null;
    };

export type TurnLivenessTransition =
  | { type: "directory_running"; startedAt: Date | null }
  | {
      type: "stream_open";
      startedAt: Date;
      evidence: TurnLivenessEvidence;
    }
  | {
      type: "stream_restart";
      startedAt: Date;
      evidence: TurnLivenessEvidence;
    }
  | { type: "stream_close" }
  | { type: "destructive_close" }
  | {
      type: "resume_snapshot";
      status: AgentLifecycleStatus;
      startedAt: Date | null;
      coverage: TurnLivenessEvidence;
    };

export const TURN_LIVENESS_IDLE: TurnLiveness = { phase: "idle" };

export function readTurnLiveness(
  turns: ReadonlyMap<string, TurnLiveness>,
  agentId: string,
): TurnLiveness {
  return turns.get(agentId) ?? TURN_LIVENESS_IDLE;
}

export function applyTurnLivenessTransition(
  turns: ReadonlyMap<string, TurnLiveness>,
  agentId: string,
  transition: TurnLivenessTransition,
): Map<string, TurnLiveness> {
  const current = readTurnLiveness(turns, agentId);
  const next = reduceTurnLiveness(current, transition);
  if (next === current) return turns as Map<string, TurnLiveness>;
  const updated = new Map(turns);
  if (next.phase === "idle") updated.delete(agentId);
  else updated.set(agentId, next);
  return updated;
}

export interface TurnPresentation {
  isActive: boolean;
  startedAt: Date | null;
}

export function resolveTurnPresentation(
  liveness: TurnLiveness,
  submissions: readonly { submittedAt: Date }[],
): TurnPresentation {
  const latestSubmission = submissions.at(-1);
  if (liveness.phase === "open") {
    return {
      isActive: true,
      startedAt: liveness.startedAt ?? latestSubmission?.submittedAt ?? null,
    };
  }
  return latestSubmission
    ? { isActive: true, startedAt: latestSubmission.submittedAt }
    : { isActive: false, startedAt: null };
}

export function reduceTurnLiveness(
  current: TurnLiveness,
  transition: TurnLivenessTransition,
): TurnLiveness {
  if (transition.type === "directory_running") {
    return current.phase === "open"
      ? current
      : {
          phase: "open",
          startedAt: transition.startedAt,
          evidence: null,
        };
  }

  if (transition.type === "stream_open") {
    return {
      phase: "open",
      startedAt:
        current.phase === "open"
          ? (current.startedAt ?? transition.startedAt)
          : transition.startedAt,
      evidence: transition.evidence,
    };
  }

  if (transition.type === "stream_restart") {
    return {
      phase: "open",
      startedAt: transition.startedAt,
      evidence: transition.evidence,
    };
  }

  if (transition.type === "stream_close" || transition.type === "destructive_close") {
    return TURN_LIVENESS_IDLE;
  }

  if (
    current.phase === "open" &&
    current.evidence?.epoch === transition.coverage.epoch &&
    current.evidence.seq > transition.coverage.seq
  ) {
    return current;
  }

  if (transition.status === "running") {
    return {
      phase: "open",
      startedAt:
        current.phase === "open"
          ? (current.startedAt ?? transition.startedAt)
          : transition.startedAt,
      evidence: transition.coverage,
    };
  }

  return TURN_LIVENESS_IDLE;
}
