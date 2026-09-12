import { describe, expect, it } from "vitest";
import {
  type AgentCommandsClient,
  type DraftCommandConfig,
  fetchAgentCommands,
  resolveCommandsStaleTime,
} from "./use-agent-commands-query";

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

describe("resolveCommandsStaleTime", () => {
  it("keeps a loaded draft command list indefinitely", () => {
    expect(
      resolveCommandsStaleTime({
        isDraft: true,
        commands: [{ name: "review", description: "", argumentHint: "" }],
      }),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("lets an empty draft command list go stale so it is retried", () => {
    const staleTime = resolveCommandsStaleTime({ isDraft: true, commands: [] });

    expect(staleTime).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(staleTime).toBeGreaterThan(0);
  });
});
