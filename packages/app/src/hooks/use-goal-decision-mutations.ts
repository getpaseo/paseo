import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Goal, GoalTimeMode, GuidanceChanges } from "@getpaseo/protocol/goal/types";
import { goalsHostQueryKey } from "@/hooks/use-goals";
import { useSessionStore } from "@/stores/session-store";

export interface PlanRevisionTarget {
  goalId: string;
  revisionId: string;
}

export interface RecoveryTarget {
  goalId: string;
  recoveryId: string;
}

export interface RecoveryStartInput {
  goalId: string;
  timeMode?: GoalTimeMode;
  guidance?: GuidanceChanges;
}

export interface GoalAcceptInput {
  goalId: string;
  criterionIds: string[];
  note: string;
  /** The same id on a retry, so the host applies one accept however often it is sent. */
  eventId?: string;
}

export interface UseGoalDecisionMutationsResult {
  /** Approve or reject a plan revision held for you (`goalPlanRevision`). */
  approvePlanRevision: (input: PlanRevisionTarget) => Promise<void>;
  rejectPlanRevision: (input: PlanRevisionTarget & { feedback?: string }) => Promise<void>;
  /** The revision an approve or reject is in flight for. */
  pendingRevisionId: string | null;
  /**
   * Recovery of a failed goal (`goalRecovery`). Each resolves with the goal the host returned.
   * Its lists are cut short (decided plan changes come without ops), so nothing caches it: the
   * detail refetches goal.inspect.
   */
  startRecovery: (input: RecoveryStartInput) => Promise<Goal | null>;
  decideRecovery: (
    input: RecoveryTarget & { approve: boolean; message?: string },
  ) => Promise<Goal | null>;
  cancelRecovery: (input: RecoveryTarget) => Promise<Goal | null>;
  isStartingRecovery: boolean;
  /** The answer an approve or reject of a recovery is in flight with; null when none is. */
  pendingRecoveryApproval: boolean | null;
  isCancellingRecovery: boolean;
  /** Accept a failed goal as is (`goalAccept`), waiving `criterionIds`; same cache rule as recovery. */
  acceptGoal: (input: GoalAcceptInput) => Promise<Goal | null>;
  isAcceptingGoal: boolean;
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

function goalOrThrow(payload: { goal: Goal | null; error: string | null }): Goal | null {
  if (payload.error) {
    throw new Error(payload.error);
  }
  return payload.goal;
}

/** Your answers to what the Lead proposes: a plan change, and a failed goal's recovery. */
export function useGoalDecisionMutations({
  serverId,
}: {
  serverId: string;
}): UseGoalDecisionMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const unavailableMessage = t("common.errors.daemonClientUnavailable");
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: goalsHostQueryKey(serverId) });
  }, [queryClient, serverId]);
  const client = useCallback(
    () => requireClient(serverId, unavailableMessage),
    [serverId, unavailableMessage],
  );

  const approveRevision = useMutation({
    mutationFn: async (input: PlanRevisionTarget): Promise<void> => {
      goalOrThrow(await client().goalApprovePlanRevision(input));
    },
    onSettled: invalidate,
  });
  const rejectRevision = useMutation({
    mutationFn: async (input: PlanRevisionTarget & { feedback?: string }): Promise<void> => {
      goalOrThrow(await client().goalRejectPlanRevision(input));
    },
    onSettled: invalidate,
  });
  const startRecovery = useMutation({
    mutationFn: async (input: RecoveryStartInput) =>
      goalOrThrow(await client().goalRecoveryStart(input)),
    onSettled: invalidate,
  });
  const decideRecovery = useMutation({
    mutationFn: async (input: RecoveryTarget & { approve: boolean; message?: string }) =>
      goalOrThrow(await client().goalRecoveryDecide(input)),
    onSettled: invalidate,
  });
  const cancelRecovery = useMutation({
    mutationFn: async (input: RecoveryTarget) =>
      goalOrThrow(await client().goalRecoveryCancel(input)),
    onSettled: invalidate,
  });
  const acceptGoal = useMutation({
    mutationFn: async (input: GoalAcceptInput) =>
      goalOrThrow(await client().goalOutcomeAccept({ ...input, client: "app" })),
    onSettled: invalidate,
  });

  const revisionInFlight = approveRevision.isPending ? approveRevision : rejectRevision;
  return {
    approvePlanRevision: approveRevision.mutateAsync,
    rejectPlanRevision: rejectRevision.mutateAsync,
    pendingRevisionId: revisionInFlight.isPending
      ? (revisionInFlight.variables?.revisionId ?? null)
      : null,
    startRecovery: startRecovery.mutateAsync,
    decideRecovery: decideRecovery.mutateAsync,
    cancelRecovery: cancelRecovery.mutateAsync,
    isStartingRecovery: startRecovery.isPending,
    pendingRecoveryApproval: decideRecovery.isPending
      ? (decideRecovery.variables?.approve ?? null)
      : null,
    isCancellingRecovery: cancelRecovery.isPending,
    acceptGoal: acceptGoal.mutateAsync,
    isAcceptingGoal: acceptGoal.isPending,
  };
}
