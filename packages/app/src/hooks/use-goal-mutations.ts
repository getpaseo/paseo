import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { GoalRetainedResource } from "@getpaseo/protocol/goal/rpc-schemas";
import type {
  Goal,
  GoalConfigChanges,
  GoalPriority,
  GoalSummary,
  GoalTimeMode,
} from "@getpaseo/protocol/goal/types";
import type { GoalCreateInput } from "@/goals/goal-form-model";
import { removeGoalFromList, replaceGoalInList } from "@/goals/goal-updates";
import {
  goalDetailQueryKey,
  goalListArchivedModeOfKey,
  goalListQueryKey,
  goalsHostQueryKey,
} from "@/hooks/use-goals";
import { useSessionStore } from "@/stores/session-store";

/** `timeMode` restarts the time limit; send it only with `goalTimeBase`. */
export interface RetryInput {
  goalId: string;
  taskId?: string;
  timeMode?: GoalTimeMode;
}

export interface UseGoalMutationsResult {
  /** Resolves with the created goal. */
  createGoal: (input: GoalCreateInput) => Promise<Goal | null>;
  approvePlan: (goalId: string) => Promise<void>;
  cancelGoal: (goalId: string) => Promise<void>;
  approveChangeSet: (input: ChangeSetTarget) => Promise<void>;
  requestChanges: (input: ChangeSetTarget & { findings: string }) => Promise<void>;
  isCreating: boolean;
  isApproving: boolean;
  isCancelling: boolean;
  /** The change set an approve or request-changes call is in flight for. */
  pendingChangeSetId: string | null;
  rejectPlan: (input: { goalId: string; feedback?: string }) => Promise<void>;
  /** Without a task, retries every failed task, reopening a failed goal. */
  retry: (input: RetryInput) => Promise<void>;
  pause: (goalId: string) => Promise<void>;
  resume: (goalId: string) => Promise<void>;
  /** Dismiss an ended goal so it stops asking for attention. */
  acknowledge: (goalId: string) => Promise<void>;
  /** The goal a dismiss is in flight for. */
  pendingAcknowledgeGoalId: string | null;
  isRejecting: boolean;
  isPausing: boolean;
  /** The task a retry is in flight for; "" for a whole-goal retry. */
  pendingRetryTaskId: string | null;
  rename: (input: { goalId: string; title: string }) => Promise<void>;
  isRenaming: boolean;
  /** Sends only the given settings; the returned goal replaces the cached one. */
  updateConfig: (input: { goalId: string; changes: GoalConfigChanges }) => Promise<void>;
  isUpdatingConfig: boolean;
  /** Shown at once in the cached lists, and put back if the host refuses it. */
  setPriority: (input: { goalId: string; priority: GoalPriority }) => Promise<void>;
  archive: (goalId: string) => Promise<void>;
  unarchive: (goalId: string) => Promise<void>;
  /** The goal an archive or unarchive is in flight for. */
  pendingArchiveGoalId: string | null;
  /** Resolves with what the goal created that delete left in place. */
  deleteGoal: (goalId: string) => Promise<GoalDeleteResult>;
  /** The goal a delete is in flight for. */
  pendingDeleteGoalId: string | null;
}

export interface GoalDeleteResult {
  /** False when the goal was already gone. */
  deleted: boolean;
  retained: GoalRetainedResource[];
}

export interface ChangeSetTarget {
  goalId: string;
  changeSetId: string;
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

function throwPayloadError(payload: { error: string | null }): void {
  if (payload.error) {
    throw new Error(payload.error);
  }
}

/**
 * Only the retry, for callers that need nothing else: a list row's menu mounts one per row, and
 * the full set would add a dozen mutation observers to each.
 */
export function useGoalRetryMutation({ serverId }: { serverId: string }): {
  retry: (input: RetryInput) => Promise<void>;
  /** The task a retry is in flight for; "" for a whole-goal retry. */
  pendingRetryTaskId: string | null;
} {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const unavailableMessage = t("common.errors.daemonClientUnavailable");
  const mutation = useMutation({
    mutationFn: async (input: RetryInput): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalRetry(input));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: goalsHostQueryKey(serverId) });
    },
  });
  return {
    retry: mutation.mutateAsync,
    pendingRetryTaskId: mutation.isPending ? (mutation.variables?.taskId ?? "") : null,
  };
}

export function useGoalMutations({ serverId }: { serverId: string }): UseGoalMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const unavailableMessage = t("common.errors.daemonClientUnavailable");

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: goalsHostQueryKey(serverId) });
  }, [queryClient, serverId]);

  /** Every cached list of this host (with and without archived goals), mapped in place. */
  const updateLists = useCallback(
    (update: (goals: GoalSummary[], archived: "exclude" | "include") => GoalSummary[]) => {
      for (const [queryKey, current] of queryClient.getQueriesData<GoalSummary[]>({
        queryKey: goalListQueryKey(serverId),
      })) {
        if (current) {
          queryClient.setQueryData(queryKey, update(current, goalListArchivedModeOfKey(queryKey)));
        }
      }
    },
    [queryClient, serverId],
  );

  /**
   * A goal a mutation returned, shown in the lists before the refetch lands. It is in the list
   * shape (decided plan changes without ops, guidance cut short, no Lead advice), so it never
   * replaces the detail's goal.inspect copy: the invalidation refetches that in full.
   */
  const applyGoal = useCallback(
    (goal: Goal | null) => {
      if (!goal) {
        return;
      }
      updateLists((goals, archived) => replaceGoalInList(goals, goal, { archived }));
    },
    [updateLists],
  );

  const createMutation = useMutation({
    mutationFn: async (input: GoalCreateInput): Promise<Goal | null> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = await client.goalCreate(input);
      throwPayloadError(payload);
      return payload.goal;
    },
    onSettled: invalidate,
  });

  const approveMutation = useMutation({
    mutationFn: async (goalId: string): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalApprovePlan({ goalId }));
    },
    onSettled: invalidate,
  });

  const cancelMutation = useMutation({
    mutationFn: async (goalId: string): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalCancel({ goalId }));
    },
    onSettled: invalidate,
  });

  const approveChangeSetMutation = useMutation({
    mutationFn: async (input: ChangeSetTarget): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalApproveChangeSet(input));
    },
    onSettled: invalidate,
  });

  const requestChangesMutation = useMutation({
    mutationFn: async (input: ChangeSetTarget & { findings: string }): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalRequestChanges(input));
    },
    onSettled: invalidate,
  });

  const rejectPlanMutation = useMutation({
    mutationFn: async (input: { goalId: string; feedback?: string }): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalRejectPlan(input));
    },
    onSettled: invalidate,
  });

  const retryMutation = useMutation({
    mutationFn: async (input: RetryInput): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalRetry(input));
    },
    onSettled: invalidate,
  });

  const pauseMutation = useMutation({
    mutationFn: async (input: { goalId: string; paused: boolean }): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = input.paused
        ? await client.goalPause({ goalId: input.goalId })
        : await client.goalResume({ goalId: input.goalId });
      throwPayloadError(payload);
    },
    onSettled: invalidate,
  });
  const pauseAsync = pauseMutation.mutateAsync;
  const pause = useCallback((goalId: string) => pauseAsync({ goalId, paused: true }), [pauseAsync]);
  const resume = useCallback(
    (goalId: string) => pauseAsync({ goalId, paused: false }),
    [pauseAsync],
  );

  const acknowledgeMutation = useMutation({
    mutationFn: async (goalId: string): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalAcknowledge({ goalId }));
    },
    onSettled: invalidate,
  });

  const renameMutation = useMutation({
    mutationFn: async (input: { goalId: string; title: string }): Promise<Goal | null> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = await client.goalRename(input);
      throwPayloadError(payload);
      return payload.goal;
    },
    onSuccess: applyGoal,
    onSettled: invalidate,
  });

  const updateConfigMutation = useMutation({
    mutationFn: async (input: {
      goalId: string;
      changes: GoalConfigChanges;
    }): Promise<Goal | null> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = await client.goalUpdateConfig(input);
      throwPayloadError(payload);
      return payload.goal;
    },
    onSuccess: applyGoal,
    onSettled: invalidate,
  });
  const updateConfigAsync = updateConfigMutation.mutateAsync;
  const updateConfig = useCallback(
    async (input: { goalId: string; changes: GoalConfigChanges }) => {
      await updateConfigAsync(input);
    },
    [updateConfigAsync],
  );

  const priorityMutation = useMutation({
    mutationFn: async (input: { goalId: string; priority: GoalPriority }): Promise<Goal | null> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = await client.goalSetPriority(input);
      throwPayloadError(payload);
      return payload.goal;
    },
    // Priority only reorders the list, so it is safe to show before the host answers.
    onMutate: (input) => {
      const previous = queryClient.getQueriesData<GoalSummary[]>({
        queryKey: goalListQueryKey(serverId),
      });
      updateLists((goals) =>
        goals.map((goal) =>
          goal.id === input.goalId ? { ...goal, priority: input.priority } : goal,
        ),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      for (const [queryKey, data] of context?.previous ?? []) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSuccess: applyGoal,
    onSettled: invalidate,
  });

  const archiveMutation = useMutation({
    mutationFn: async (input: { goalId: string; archived: boolean }): Promise<Goal | null> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = input.archived
        ? await client.goalArchive({ goalId: input.goalId })
        : await client.goalUnarchive({ goalId: input.goalId });
      throwPayloadError(payload);
      return payload.goal;
    },
    onSuccess: applyGoal,
    onSettled: invalidate,
  });
  const archiveAsync = archiveMutation.mutateAsync;
  const archive = useCallback(
    async (goalId: string) => {
      await archiveAsync({ goalId, archived: true });
    },
    [archiveAsync],
  );
  const unarchive = useCallback(
    async (goalId: string) => {
      await archiveAsync({ goalId, archived: false });
    },
    [archiveAsync],
  );

  const deleteMutation = useMutation({
    mutationFn: async (goalId: string): Promise<GoalDeleteResult> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = await client.goalDelete({ goalId });
      throwPayloadError(payload);
      return { deleted: payload.deleted, retained: payload.retained };
    },
    onSuccess: (_result, goalId) => {
      updateLists((goals) => removeGoalFromList(goals, goalId));
      queryClient.removeQueries({ queryKey: goalDetailQueryKey(serverId, goalId) });
    },
    onSettled: invalidate,
  });

  const renameAsync = renameMutation.mutateAsync;
  const rename = useCallback(
    async (input: { goalId: string; title: string }) => {
      await renameAsync(input);
    },
    [renameAsync],
  );
  const priorityAsync = priorityMutation.mutateAsync;
  const setPriority = useCallback(
    async (input: { goalId: string; priority: GoalPriority }) => {
      await priorityAsync(input);
    },
    [priorityAsync],
  );

  let pendingChangeSetId: string | null = null;
  if (approveChangeSetMutation.isPending) {
    pendingChangeSetId = approveChangeSetMutation.variables?.changeSetId ?? null;
  } else if (requestChangesMutation.isPending) {
    pendingChangeSetId = requestChangesMutation.variables?.changeSetId ?? null;
  }

  // mutateAsync is referentially stable across renders.
  return {
    createGoal: createMutation.mutateAsync,
    approvePlan: approveMutation.mutateAsync,
    cancelGoal: cancelMutation.mutateAsync,
    approveChangeSet: approveChangeSetMutation.mutateAsync,
    requestChanges: requestChangesMutation.mutateAsync,
    pendingChangeSetId,
    rejectPlan: rejectPlanMutation.mutateAsync,
    retry: retryMutation.mutateAsync,
    pause,
    resume,
    acknowledge: acknowledgeMutation.mutateAsync,
    pendingAcknowledgeGoalId: acknowledgeMutation.isPending
      ? (acknowledgeMutation.variables ?? null)
      : null,
    isRejecting: rejectPlanMutation.isPending,
    isPausing: pauseMutation.isPending,
    pendingRetryTaskId: retryMutation.isPending ? (retryMutation.variables?.taskId ?? "") : null,
    rename,
    isRenaming: renameMutation.isPending,
    updateConfig,
    isUpdatingConfig: updateConfigMutation.isPending,
    setPriority,
    archive,
    unarchive,
    pendingArchiveGoalId: archiveMutation.isPending
      ? (archiveMutation.variables?.goalId ?? null)
      : null,
    deleteGoal: deleteMutation.mutateAsync,
    pendingDeleteGoalId: deleteMutation.isPending ? (deleteMutation.variables ?? null) : null,
    isCreating: createMutation.isPending,
    isApproving: approveMutation.isPending,
    isCancelling: cancelMutation.isPending,
  };
}
