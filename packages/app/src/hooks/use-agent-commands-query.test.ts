/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAgentCommandsQuery } from "./use-agent-commands-query";

const { mockClient, mockRuntime } = vi.hoisted(() => {
  const hoistedClient = {
    listCommands: vi.fn(),
  };
  return {
    mockClient: hoistedClient,
    mockRuntime: {
      client: hoistedClient,
      isConnected: true,
    },
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockRuntime.client,
  useHostRuntimeIsConnected: () => mockRuntime.isConnected,
}));

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderCommandsHook(input: Parameters<typeof useAgentCommandsQuery>[0]) {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return renderHook(() => useAgentCommandsQuery(input), { wrapper });
}

describe("useAgentCommandsQuery", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockRuntime.client = mockClient;
    mockRuntime.isConnected = true;
  });

  it("loads commands for a draft composer without an agent id", async () => {
    mockClient.listCommands.mockResolvedValue({
      commands: [{ name: "compact", description: "Compact context", argumentHint: "" }],
    });

    const draftConfig = {
      provider: "opencode" as const,
      cwd: "/repo",
      modeId: "build",
    };

    const { result } = renderCommandsHook({
      serverId: "server-1",
      agentId: "",
      draftConfig,
    });

    await waitFor(() => {
      expect(result.current.commands).toEqual([
        { name: "compact", description: "Compact context", argumentHint: "" },
      ]);
    });

    expect(mockClient.listCommands).toHaveBeenCalledWith("", { draftConfig });
  });
});
