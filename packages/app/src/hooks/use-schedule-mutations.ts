import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  CreateScheduleOptions,
  DaemonClient,
  UpdateScheduleOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type {
  AggregatedSchedule,
  FetchAggregatedSchedulesState,
} from "@/schedules/aggregated-schedules";
import { schedulesQueryBaseKey } from "@/schedules/aggregated-schedules";
import { useSessionStore } from "@/stores/session-store";

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

interface ScheduleListSnapshot {
  previous: Array<[QueryKey, FetchAggregatedSchedulesState | undefined]>;
}

export function updateAggregatedSchedulesData(
  current: FetchAggregatedSchedulesState | undefined,
  updateSchedules: (schedules: AggregatedSchedule[]) => AggregatedSchedule[],
): FetchAggregatedSchedulesState | undefined {
  if (!current || current.status !== "loaded") {
    return current;
  }
  return { ...current, data: updateSchedules(current.data) };
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

function snapshotSchedules(queryClient: QueryClient): ScheduleListSnapshot {
  return {
    previous: queryClient.getQueriesData<FetchAggregatedSchedulesState>({
      queryKey: schedulesQueryBaseKey,
    }),
  };
}

function restoreSchedules(queryClient: QueryClient, snapshot: ScheduleListSnapshot): void {
  for (const [queryKey, previous] of snapshot.previous) {
    queryClient.setQueryData(queryKey, previous);
  }
}

function updateSchedulesData(
  queryClient: QueryClient,
  updateSchedules: (schedules: AggregatedSchedule[]) => AggregatedSchedule[],
): void {
  queryClient.setQueriesData<FetchAggregatedSchedulesState>(
    { queryKey: schedulesQueryBaseKey },
    (current) => updateAggregatedSchedulesData(current, updateSchedules),
  );
}

function optimisticallySetStatus(
  queryClient: QueryClient,
  serverId: string,
  id: string,
  status: ScheduleSummary["status"],
): void {
  const pausedAt = status === "paused" ? new Date().toISOString() : null;
  updateSchedulesData(queryClient, (schedules) =>
    schedules.map((schedule) =>
      schedule.serverId === serverId && schedule.id === id
        ? { ...schedule, status, pausedAt }
        : schedule,
    ),
  );
}

function optimisticallyRemove(queryClient: QueryClient, serverId: string, id: string): void {
  updateSchedulesData(queryClient, (schedules) =>
    schedules.filter((schedule) => !(schedule.serverId === serverId && schedule.id === id)),
  );
}

export function useScheduleMutations({
  serverId,
}: {
  serverId: string;
}): UseScheduleMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: schedulesQueryBaseKey });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateScheduleInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.scheduleCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateScheduleInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.scheduleUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const pauseMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.schedulePause({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (id): Promise<ScheduleListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: schedulesQueryBaseKey });
      const snapshot = snapshotSchedules(queryClient);
      optimisticallySetStatus(queryClient, serverId, id, "paused");
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreSchedules(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.scheduleResume({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (id): Promise<ScheduleListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: schedulesQueryBaseKey });
      const snapshot = snapshotSchedules(queryClient);
      optimisticallySetStatus(queryClient, serverId, id, "active");
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreSchedules(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.scheduleDelete({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (id): Promise<ScheduleListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: schedulesQueryBaseKey });
      const snapshot = snapshotSchedules(queryClient);
      optimisticallyRemove(queryClient, serverId, id);
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreSchedules(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const runNowMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
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
