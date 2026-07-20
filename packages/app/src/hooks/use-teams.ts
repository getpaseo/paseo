import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Team, TeamCreateInput, TeamUpdateInput } from "@getpaseo/protocol/messages";
import { teamsQueryKey } from "@/data/team";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface UseTeamsResult {
  teams: Team[];
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
  createTeam: (input: TeamCreateInput) => Promise<Team>;
  updateTeam: (input: TeamUpdateInput) => Promise<Team>;
  deleteTeam: (id: string) => Promise<void>;
  isMutating: boolean;
  mutationError: Error | null;
}

export function useTeams(serverId: string): UseTeamsResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => teamsQueryKey(serverId), [serverId]);

  const query = useReplicaQuery({
    queryKey,
    pushEvent: "team.changed",
    enabled: Boolean(client && isConnected),
    queryFn: async () => {
      if (!client) throw new Error("Host is disconnected");
      const result = await client.listTeams();
      if (result.error) throw new Error(result.error);
      return result.teams;
    },
  });

  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<Team[]>) => operation(),
    onSuccess: (teams) => queryClient.setQueryData(queryKey, teams),
  });

  const createTeam = useCallback(
    async (input: TeamCreateInput) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      return mutation
        .mutateAsync(async () => {
          const result = await client.createTeam(input);
          if (result.error) throw new Error(result.error);
          const team = result.team;
          if (!team) throw new Error("Team is unavailable");
          return [...(query.data ?? []), team];
        })
        .then((teams) => teams[teams.length - 1]!);
    },
    [client, mutation, query.data],
  );

  const updateTeam = useCallback(
    async (input: TeamUpdateInput) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      return mutation
        .mutateAsync(async () => {
          const result = await client.updateTeam(input);
          if (result.error) throw new Error(result.error);
          const team = result.team;
          if (!team) throw new Error("Team is unavailable");
          return (query.data ?? []).map((t) => (t.id === team.id ? team : t));
        })
        .then((teams) => teams.find((t) => t.id === input.id)!);
    },
    [client, mutation, query.data],
  );

  const deleteTeam = useCallback(
    async (id: string) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      await mutation.mutateAsync(async () => {
        const result = await client.deleteTeam(id);
        if (result.error) throw new Error(result.error);
        return (query.data ?? []).filter((t) => t.id !== id);
      });
    },
    [client, mutation, query.data],
  );

  return {
    teams: query.data ?? [],
    isLoading: query.isLoading,
    isConnected,
    error: query.error,
    createTeam,
    updateTeam,
    deleteTeam,
    isMutating: mutation.isPending,
    mutationError: mutation.error,
  };
}
