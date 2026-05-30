import { useCallback } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  CreateScheduleOptions,
  DaemonClient,
  UpdateScheduleOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { useSessionStore } from "@/stores/session-store";
import { schedulesQueryKey } from "@/hooks/use-schedules";

export type CreateScheduleInput = Omit<CreateScheduleOptions, "requestId">;
export type UpdateScheduleInput = Omit<UpdateScheduleOptions, "requestId">;

export interface UseScheduleMutationsResult {
  createSchedule: (input: CreateScheduleInput) => Promise<void>;
  updateSchedule: (input: UpdateScheduleInput) => Promise<void>;
  pauseSchedule: (id: string) => Promise<void>;
  resumeSchedule: (id: string) => Promise<void>;
  deleteSchedule: (id: string) => Promise<void>;
  runScheduleNow: (id: string) => Promise<void>;
  isCreating: boolean;
  isUpdating: boolean;
  isPausing: boolean;
  isResuming: boolean;
  isDeleting: boolean;
  isRunningNow: boolean;
}

function requireClient(serverId: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error("Daemon client not available");
  }
  return client;
}

interface ScheduleListSnapshot {
  previous: ScheduleSummary[] | undefined;
}

function snapshotSchedules(queryClient: QueryClient, serverId: string): ScheduleListSnapshot {
  return {
    previous: queryClient.getQueryData<ScheduleSummary[]>(schedulesQueryKey(serverId)),
  };
}

function restoreSchedules(
  queryClient: QueryClient,
  serverId: string,
  snapshot: ScheduleListSnapshot,
): void {
  if (snapshot.previous === undefined) {
    return;
  }
  queryClient.setQueryData(schedulesQueryKey(serverId), snapshot.previous);
}

function optimisticallySetStatus(
  queryClient: QueryClient,
  serverId: string,
  id: string,
  status: ScheduleSummary["status"],
): void {
  queryClient.setQueryData<ScheduleSummary[]>(schedulesQueryKey(serverId), (current) => {
    if (!current) {
      return current;
    }
    const pausedAt = status === "paused" ? new Date().toISOString() : null;
    return current.map((schedule) =>
      schedule.id === id ? { ...schedule, status, pausedAt } : schedule,
    );
  });
}

function optimisticallyRemove(queryClient: QueryClient, serverId: string, id: string): void {
  queryClient.setQueryData<ScheduleSummary[]>(schedulesQueryKey(serverId), (current) => {
    if (!current) {
      return current;
    }
    return current.filter((schedule) => schedule.id !== id);
  });
}

export function useScheduleMutations({
  serverId,
}: {
  serverId: string;
}): UseScheduleMutationsResult {
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: schedulesQueryKey(serverId) });
  }, [queryClient, serverId]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateScheduleInput): Promise<void> => {
      const client = requireClient(serverId);
      const payload = await client.scheduleCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateScheduleInput): Promise<void> => {
      const client = requireClient(serverId);
      const payload = await client.scheduleUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const pauseMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId);
      const payload = await client.schedulePause({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (id): Promise<ScheduleListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: schedulesQueryKey(serverId) });
      const snapshot = snapshotSchedules(queryClient, serverId);
      optimisticallySetStatus(queryClient, serverId, id, "paused");
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreSchedules(queryClient, serverId, context);
      }
    },
    onSettled: invalidate,
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId);
      const payload = await client.scheduleResume({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (id): Promise<ScheduleListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: schedulesQueryKey(serverId) });
      const snapshot = snapshotSchedules(queryClient, serverId);
      optimisticallySetStatus(queryClient, serverId, id, "active");
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreSchedules(queryClient, serverId, context);
      }
    },
    onSettled: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId);
      const payload = await client.scheduleDelete({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (id): Promise<ScheduleListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: schedulesQueryKey(serverId) });
      const snapshot = snapshotSchedules(queryClient, serverId);
      optimisticallyRemove(queryClient, serverId, id);
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreSchedules(queryClient, serverId, context);
      }
    },
    onSettled: invalidate,
  });

  const runNowMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId);
      const payload = await client.scheduleRunOnce({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const createSchedule = useCallback(
    async (input: CreateScheduleInput): Promise<void> => {
      await createMutation.mutateAsync(input);
    },
    [createMutation],
  );

  const updateSchedule = useCallback(
    async (input: UpdateScheduleInput): Promise<void> => {
      await updateMutation.mutateAsync(input);
    },
    [updateMutation],
  );

  const pauseSchedule = useCallback(
    async (id: string): Promise<void> => {
      await pauseMutation.mutateAsync(id);
    },
    [pauseMutation],
  );

  const resumeSchedule = useCallback(
    async (id: string): Promise<void> => {
      await resumeMutation.mutateAsync(id);
    },
    [resumeMutation],
  );

  const deleteSchedule = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  const runScheduleNow = useCallback(
    async (id: string): Promise<void> => {
      await runNowMutation.mutateAsync(id);
    },
    [runNowMutation],
  );

  return {
    createSchedule,
    updateSchedule,
    pauseSchedule,
    resumeSchedule,
    deleteSchedule,
    runScheduleNow,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isPausing: pauseMutation.isPending,
    isResuming: resumeMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isRunningNow: runNowMutation.isPending,
  };
}
