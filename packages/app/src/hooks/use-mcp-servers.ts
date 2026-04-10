import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateMcpServerOptions,
  UpdateMcpServerOptions,
  ToggleMcpServerOptions,
  ListMcpServersResult,
  CreateMcpServerResult,
  UpdateMcpServerResult,
  DeleteMcpServerResult,
  ToggleMcpServerResult,
} from "@server/client/daemon-client";
import type { McpServerRecord } from "@server/server/mcp/mcp-server-types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function mcpServersQueryKey(serverId: string | null) {
  return ["mcpServers", serverId] as const;
}

interface UseMcpServersResult {
  servers: McpServerRecord[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: string | null;
  refetch: () => void;
  invalidate: () => void;
}

export function useMcpServers(serverId: string | null): UseMcpServersResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const queryKey = useMemo(() => mcpServersQueryKey(serverId), [serverId]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 30_000,
    queryFn: async (): Promise<ListMcpServersResult> => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return client.listMcpServers();
    },
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    servers: query.data?.servers,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : (query.data?.error ?? null),
    refetch,
    invalidate,
  };
}

interface UseCreateMcpServerResult {
  create: (options: CreateMcpServerOptions) => Promise<CreateMcpServerResult>;
  isLoading: boolean;
}

export function useCreateMcpServer(serverId: string | null): UseCreateMcpServerResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryClient = useQueryClient();

  const [isLoading, setIsLoading] = useState(false);

  const create = useCallback(
    async (options: CreateMcpServerOptions): Promise<CreateMcpServerResult> => {
      if (!client || !isConnected) {
        throw new Error("Host is not connected");
      }
      setIsLoading(true);
      try {
        const result = await client.createMcpServer(options);
        void queryClient.invalidateQueries({ queryKey: mcpServersQueryKey(serverId) });
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [client, isConnected, serverId, queryClient],
  );

  return { create, isLoading };
}

interface UseUpdateMcpServerResult {
  update: (id: string, options: UpdateMcpServerOptions) => Promise<UpdateMcpServerResult>;
  isLoading: boolean;
}

export function useUpdateMcpServer(serverId: string | null): UseUpdateMcpServerResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryClient = useQueryClient();

  const [isLoading, setIsLoading] = useState(false);

  const update = useCallback(
    async (id: string, options: UpdateMcpServerOptions): Promise<UpdateMcpServerResult> => {
      if (!client || !isConnected) {
        throw new Error("Host is not connected");
      }
      setIsLoading(true);
      try {
        const result = await client.updateMcpServer(id, options);
        void queryClient.invalidateQueries({ queryKey: mcpServersQueryKey(serverId) });
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [client, isConnected, serverId, queryClient],
  );

  return { update, isLoading };
}

interface UseDeleteMcpServerResult {
  remove: (id: string) => Promise<DeleteMcpServerResult>;
  isLoading: boolean;
}

export function useDeleteMcpServer(serverId: string | null): UseDeleteMcpServerResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryClient = useQueryClient();

  const [isLoading, setIsLoading] = useState(false);

  const remove = useCallback(
    async (id: string): Promise<DeleteMcpServerResult> => {
      if (!client || !isConnected) {
        throw new Error("Host is not connected");
      }
      setIsLoading(true);
      try {
        const result = await client.deleteMcpServer(id);
        void queryClient.invalidateQueries({ queryKey: mcpServersQueryKey(serverId) });
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [client, isConnected, serverId, queryClient],
  );

  return { remove, isLoading };
}

interface UseToggleMcpServerResult {
  toggle: (options: ToggleMcpServerOptions) => Promise<ToggleMcpServerResult>;
  isLoading: boolean;
}

export function useToggleMcpServer(serverId: string | null): UseToggleMcpServerResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryClient = useQueryClient();

  const [isLoading, setIsLoading] = useState(false);

  const toggle = useCallback(
    async (options: ToggleMcpServerOptions): Promise<ToggleMcpServerResult> => {
      if (!client || !isConnected) {
        throw new Error("Host is not connected");
      }
      setIsLoading(true);
      try {
        const result = await client.toggleMcpServer(options);
        void queryClient.invalidateQueries({ queryKey: mcpServersQueryKey(serverId) });
        return result;
      } finally {
        setIsLoading(false);
      }
    },
    [client, isConnected, serverId, queryClient],
  );

  return { toggle, isLoading };
}
