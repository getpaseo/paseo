// @vitest-environment jsdom

import { createElement } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentCommandsClient,
  type DraftCommandConfig,
  fetchAgentCommands,
  useAgentCommandsQuery,
} from "./use-agent-commands-query";

const runtime = vi.hoisted(() => ({ client: { listCommands: vi.fn() } }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => true,
}));

type ListCommands = AgentCommandsClient["listCommands"];
type ListCommandsResult = Awaited<ReturnType<ListCommands>>;

interface ListCommandsCall {
  agentId: string;
  draftConfig: DraftCommandConfig | undefined;
}

interface FakeAgentCommandsClient extends AgentCommandsClient {
  calls: ListCommandsCall[];
}

function createClient(response: ListCommandsResult): FakeAgentCommandsClient {
  const calls: ListCommandsCall[] = [];
  return {
    calls,
    listCommands: (async (options: Parameters<ListCommands>[0]) => {
      calls.push({ agentId: options.agentId, draftConfig: options.draftConfig });
      return response;
    }) as ListCommands,
  };
}

function commandsPayload(commands: ListCommandsResult["commands"]): ListCommandsResult {
  return {
    requestId: "req_commands",
    agentId: "",
    error: null,
    commands,
  };
}

describe("fetchAgentCommands", () => {
  it("loads commands for a draft composer without an agent id", async () => {
    const client = createClient(
      commandsPayload([{ name: "compact", description: "Compact context", argumentHint: "" }]),
    );

    const draftConfig: DraftCommandConfig = {
      provider: "opencode",
      cwd: "/repo",
      modeId: "build",
    };

    const commands = await fetchAgentCommands({ client, agentId: "", draftConfig });

    expect(commands).toEqual([
      { name: "compact", description: "Compact context", argumentHint: "" },
    ]);
    expect(client.calls).toEqual([{ agentId: "", draftConfig }]);
  });

  it("passes the agent id when fetching commands for a running agent", async () => {
    const client = createClient(commandsPayload([]));

    await fetchAgentCommands({ client, agentId: "agent-1" });

    expect(client.calls).toEqual([{ agentId: "agent-1", draftConfig: undefined }]);
  });
});

describe("draft command failures", () => {
  it("surfaces a daemon error for a draft composer instead of an empty command list", async () => {
    const client = createClient({
      requestId: "req_commands",
      agentId: "",
      error: "Provider 'codex' has no models available, so its commands cannot be listed.",
      commands: [],
    });

    await expect(
      fetchAgentCommands({
        client,
        agentId: "",
        draftConfig: { provider: "codex", cwd: "/repo" },
      }),
    ).rejects.toThrow("has no models available");
  });

  it("keeps a running agent usable when the provider cannot list commands", async () => {
    const client = createClient({
      requestId: "req_commands",
      agentId: "agent-1",
      error: "Agent does not support listing commands",
      commands: [],
    });

    await expect(fetchAgentCommands({ client, agentId: "agent-1" })).resolves.toEqual([]);
  });
});

it("refetches an empty draft result when the slash menu reopens after it goes stale", async () => {
  vi.useFakeTimers();
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const commands = [{ name: "review", description: "", argumentHint: "" }];
  runtime.client.listCommands.mockResolvedValueOnce(commandsPayload([]));
  runtime.client.listCommands.mockResolvedValue(commandsPayload(commands));
  const hook = renderHook(
    ({ enabled }) =>
      useAgentCommandsQuery({
        serverId: "server-1",
        agentId: "",
        draftConfig: { provider: "codex", cwd: "/repo" },
        enabled,
      }),
    {
      initialProps: { enabled: true },
      wrapper: ({ children }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    },
  );
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.commands).toEqual([]);
    expect(hook.result.current.isLoading).toBe(false);
    hook.rerender({ enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    hook.rerender({ enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(hook.result.current.commands).toEqual(commands);
    expect(runtime.client.listCommands).toHaveBeenCalledTimes(2);

    hook.rerender({ enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    hook.rerender({ enabled: true });
    expect(runtime.client.listCommands).toHaveBeenCalledTimes(2);
  } finally {
    hook.unmount();
    queryClient.clear();
    vi.useRealTimers();
  }
});
