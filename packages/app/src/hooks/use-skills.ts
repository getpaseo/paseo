import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Skill, SkillCreateInput, SkillUpdateInput } from "@getpaseo/protocol/messages";
import { skillsQueryKey } from "@/data/skill";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface UseSkillsResult {
  skills: Skill[];
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
  createSkill: (input: SkillCreateInput) => Promise<Skill>;
  updateSkill: (input: SkillUpdateInput) => Promise<Skill>;
  deleteSkill: (id: string) => Promise<void>;
  isMutating: boolean;
  mutationError: Error | null;
}

export function useSkills(serverId: string): UseSkillsResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => skillsQueryKey(serverId), [serverId]);

  const query = useReplicaQuery({
    queryKey,
    pushEvent: "skill.changed",
    enabled: Boolean(client && isConnected),
    queryFn: async () => {
      if (!client) throw new Error("Host is disconnected");
      const result = await client.listSkills();
      if (result.error) throw new Error(result.error);
      return result.skills;
    },
  });

  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<Skill[]>) => operation(),
    onSuccess: (skills) => queryClient.setQueryData(queryKey, skills),
  });

  const createSkill = useCallback(
    async (input: SkillCreateInput) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      return mutation
        .mutateAsync(async () => {
          const result = await client.createSkill(input);
          if (result.error) throw new Error(result.error);
          const skill = result.skill;
          if (!skill) throw new Error("Skill is unavailable");
          return [...(query.data ?? []), skill];
        })
        .then((skills) => skills[skills.length - 1]!);
    },
    [client, mutation, query.data],
  );

  const updateSkill = useCallback(
    async (input: SkillUpdateInput) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      return mutation
        .mutateAsync(async () => {
          const result = await client.updateSkill(input);
          if (result.error) throw new Error(result.error);
          const skill = result.skill;
          if (!skill) throw new Error("Skill is unavailable");
          return (query.data ?? []).map((s) => (s.id === skill.id ? skill : s));
        })
        .then((skills) => skills.find((s) => s.id === input.id)!);
    },
    [client, mutation, query.data],
  );

  const deleteSkill = useCallback(
    async (id: string) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      await mutation.mutateAsync(async () => {
        const result = await client.deleteSkill(id);
        if (result.error) throw new Error(result.error);
        return (query.data ?? []).filter((s) => s.id !== id);
      });
    },
    [client, mutation, query.data],
  );

  return {
    skills: query.data ?? [],
    isLoading: query.isLoading,
    isConnected,
    error: query.error,
    createSkill,
    updateSkill,
    deleteSkill,
    isMutating: mutation.isPending,
    mutationError: mutation.error,
  };
}
