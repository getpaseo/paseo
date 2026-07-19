import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  McpServer,
  McpServerCreateInput,
  McpServerUpdateInput,
} from "@getpaseo/protocol/messages";
import { mcpServersQueryKey } from "@/data/mcp";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface UseMcpServersResult {
  servers: McpServer[];
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
  createServer: (input: McpServerCreateInput) => Promise<McpServer>;
  updateServer: (input: McpServerUpdateInput) => Promise<McpServer>;
  deleteServer: (id: string) => Promise<void>;
  isMutating: boolean;
  mutationError: Error | null;
}

export function useMcpServers(serverId: string): UseMcpServersResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => mcpServersQueryKey(serverId), [serverId]);

  const query = useReplicaQuery({
    queryKey,
    pushEvent: "mcp.changed",
    enabled: Boolean(client && isConnected),
    queryFn: async () => {
      if (!client) throw new Error("Host is disconnected");
      const result = await client.listMcpServers();
      if (result.error) throw new Error(result.error);
      return result.servers;
    },
  });

  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<McpServer[]>) => operation(),
    onSuccess: (servers) => queryClient.setQueryData(queryKey, servers),
  });

  const createServer = useCallback(
    async (input: McpServerCreateInput) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      return mutation
        .mutateAsync(async () => {
          const result = await client.createMcpServer(input);
          if (result.error) throw new Error(result.error);
          const server = result.server;
          if (!server) throw new Error("MCP server is unavailable");
          return [...(query.data ?? []), server];
        })
        .then((servers) => servers[servers.length - 1]!);
    },
    [client, mutation, query.data],
  );

  const updateServer = useCallback(
    async (input: McpServerUpdateInput) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      return mutation
        .mutateAsync(async () => {
          const result = await client.updateMcpServer(input);
          if (result.error) throw new Error(result.error);
          const server = result.server;
          if (!server) throw new Error("MCP server is unavailable");
          return (query.data ?? []).map((s) => (s.id === server.id ? server : s));
        })
        .then((servers) => servers.find((s) => s.id === input.id)!);
    },
    [client, mutation, query.data],
  );

  const deleteServer = useCallback(
    async (id: string) => {
      if (!client) return Promise.reject(new Error("Host is disconnected"));
      await mutation.mutateAsync(async () => {
        const result = await client.deleteMcpServer(id);
        if (result.error) throw new Error(result.error);
        return (query.data ?? []).filter((s) => s.id !== id);
      });
    },
    [client, mutation, query.data],
  );

  return {
    servers: query.data ?? [],
    isLoading: query.isLoading,
    isConnected,
    error: query.error,
    createServer,
    updateServer,
    deleteServer,
    isMutating: mutation.isPending,
    mutationError: mutation.error,
  };
}
