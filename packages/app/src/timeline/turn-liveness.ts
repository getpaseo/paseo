export interface ActiveTurnIdentity {
  turnId: string | null;
  startedAt: Date | null;
}

export type TurnLiveness =
  | { phase: "idle"; cancellationRequestId: number | null }
  | {
      phase: "open";
      turnId: string | null;
      startedAt: Date | null;
      cancellationRequestId: number | null;
    };

export type TurnLivenessTransition =
  | { type: "snapshot"; activeTurn: ActiveTurnIdentity | null }
  | { type: "stream_open"; turn: ActiveTurnIdentity }
  | { type: "stream_close"; turnId: string | null }
  | { type: "cancellation_started"; requestId: number }
  | { type: "cancellation_settled"; requestId: number }
  | { type: "destructive_close" };

export const TURN_LIVENESS_IDLE: TurnLiveness = {
  phase: "idle",
  cancellationRequestId: null,
};

export function readTurnLiveness(
  turns: ReadonlyMap<string, TurnLiveness>,
  agentId: string,
): TurnLiveness {
  return turns.get(agentId) ?? TURN_LIVENESS_IDLE;
}

export function applyTurnLivenessTransition(
  turns: ReadonlyMap<string, TurnLiveness>,
  agentId: string,
  transition: TurnLivenessTransition | readonly TurnLivenessTransition[],
): Map<string, TurnLiveness> {
  const current = readTurnLiveness(turns, agentId);
  const transitions = Array.isArray(transition) ? transition : [transition];
  const next = transitions.reduce(reduceTurnLiveness, current);
  if (next === current) return turns as Map<string, TurnLiveness>;
  const updated = new Map(turns);
  if (next.phase === "idle" && next.cancellationRequestId === null) updated.delete(agentId);
  else updated.set(agentId, next);
  return updated;
}

export interface TurnPresentation {
  isActive: boolean;
  isCancelling: boolean;
  startedAt: Date | null;
  turnId: string | null;
}

export function resolveTurnPresentation(
  liveness: TurnLiveness,
  hasActiveSubmission: boolean,
): TurnPresentation {
  if (liveness.phase === "open") {
    return {
      isActive: true,
      isCancelling: liveness.cancellationRequestId !== null,
      startedAt: liveness.startedAt,
      turnId: liveness.turnId,
    };
  }
  return {
    isActive: hasActiveSubmission,
    isCancelling: liveness.cancellationRequestId !== null,
    startedAt: null,
    turnId: null,
  };
}

function closeTurn(current: TurnLiveness, turnId: string | null): TurnLiveness {
  // COMPAT(agentTurnIdentity): added in v0.2.6, remove after 2027-01-31 once daemon floor >= v0.2.6.
  const targetsDifferentIdentifiedTurn =
    current.phase === "open" &&
    turnId !== null &&
    current.turnId !== null &&
    turnId !== current.turnId;
  return targetsDifferentIdentifiedTurn ? current : TURN_LIVENESS_IDLE;
}

function openTurn(current: TurnLiveness, activeTurn: ActiveTurnIdentity): TurnLiveness {
  // COMPAT(agentTurnIdentity): added in v0.2.6, remove after 2027-01-31 once daemon floor >= v0.2.6.
  const sameTurn =
    current.phase === "open" &&
    ((activeTurn.turnId !== null && current.turnId === activeTurn.turnId) ||
      (activeTurn.turnId === null && current.turnId === null));
  return {
    phase: "open",
    turnId: activeTurn.turnId,
    startedAt: sameTurn ? (current.startedAt ?? activeTurn.startedAt) : activeTurn.startedAt,
    cancellationRequestId:
      sameTurn || current.phase === "idle" ? current.cancellationRequestId : null,
  };
}

export function reduceTurnLiveness(
  current: TurnLiveness,
  transition: TurnLivenessTransition,
): TurnLiveness {
  if (transition.type === "destructive_close") return TURN_LIVENESS_IDLE;

  if (transition.type === "cancellation_started") {
    if (current.cancellationRequestId === transition.requestId) return current;
    return { ...current, cancellationRequestId: transition.requestId };
  }

  if (transition.type === "cancellation_settled") {
    if (current.cancellationRequestId !== transition.requestId) return current;
    return { ...current, cancellationRequestId: null };
  }

  if (transition.type === "stream_close") {
    return closeTurn(current, transition.turnId);
  }

  const activeTurn = transition.type === "snapshot" ? transition.activeTurn : transition.turn;
  if (!activeTurn) return TURN_LIVENESS_IDLE;
  return openTurn(current, activeTurn);
}
