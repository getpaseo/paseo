import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  CreateScheduleOptions,
  UpdateScheduleOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { ScheduleSummary, StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const SCHEDULE_LIST_POLL_MS = 10_000;

export function scheduleQueryRoot(serverId: string | null): readonly unknown[] {
  return ["schedule", serverId ?? ""];
}

export function scheduleListQueryKey(serverId: string | null): readonly unknown[] {
  return ["schedule", serverId ?? "", "list"];
}

export function scheduleDetailQueryKey(serverId: string | null, id: string): readonly unknown[] {
  return ["schedule", serverId ?? "", "detail", id];
}

interface UseSchedulesResult {
  schedules: ScheduleSummary[];
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  refetch: () => void;
}

export function useSchedules(serverId: string | null): UseSchedulesResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const query = useQuery({
    queryKey: scheduleListQueryKey(serverId),
    enabled: Boolean(serverId && client && isConnected),
    refetchInterval: SCHEDULE_LIST_POLL_MS,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.scheduleList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.schedules;
    },
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    schedules: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refetch,
  };
}

interface UseScheduleDetailResult {
  schedule: StoredSchedule | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useScheduleDetail(
  serverId: string | null,
  id: string | null,
): UseScheduleDetailResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const query = useQuery({
    queryKey: scheduleDetailQueryKey(serverId, id ?? ""),
    enabled: Boolean(serverId && id && client && isConnected),
    refetchInterval: SCHEDULE_LIST_POLL_MS,
    queryFn: async () => {
      if (!client || !id) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.scheduleInspect({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.schedule;
    },
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    schedule: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch,
  };
}

export interface ScheduleMutations {
  create: (options: Omit<CreateScheduleOptions, "requestId">) => Promise<ScheduleSummary | null>;
  update: (options: Omit<UpdateScheduleOptions, "requestId">) => Promise<StoredSchedule | null>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  runOnce: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useScheduleMutations(serverId: string | null): ScheduleMutations {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: scheduleQueryRoot(serverId), exact: false });
  }, [queryClient, serverId]);

  const requireClient = useCallback(() => {
    if (!client) {
      throw new Error(t("workspace.terminal.hostDisconnected"));
    }
    return client;
  }, [client, t]);

  const createMutation = useMutation({
    mutationFn: async (options: Omit<CreateScheduleOptions, "requestId">) => {
      const payload = await requireClient().scheduleCreate(options);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.schedule;
    },
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (options: Omit<UpdateScheduleOptions, "requestId">) => {
      const payload = await requireClient().scheduleUpdate(options);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.schedule;
    },
    onSuccess: invalidate,
  });

  const pauseMutation = useMutation({
    mutationFn: async (id: string) => {
      const payload = await requireClient().schedulePause({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSuccess: invalidate,
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string) => {
      const payload = await requireClient().scheduleResume({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSuccess: invalidate,
  });

  const runOnceMutation = useMutation({
    mutationFn: async (id: string) => {
      const payload = await requireClient().scheduleRunOnce({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const payload = await requireClient().scheduleDelete({ id });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSuccess: invalidate,
  });

  return useMemo(
    () => ({
      create: (options) => createMutation.mutateAsync(options),
      update: (options) => updateMutation.mutateAsync(options),
      pause: async (id) => {
        await pauseMutation.mutateAsync(id);
      },
      resume: async (id) => {
        await resumeMutation.mutateAsync(id);
      },
      runOnce: async (id) => {
        await runOnceMutation.mutateAsync(id);
      },
      remove: async (id) => {
        await removeMutation.mutateAsync(id);
      },
    }),
    [
      createMutation,
      updateMutation,
      pauseMutation,
      resumeMutation,
      runOnceMutation,
      removeMutation,
    ],
  );
}
