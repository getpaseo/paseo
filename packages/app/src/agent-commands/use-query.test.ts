import { describe, expect, it } from "vitest";
import { type AgentCommandsClient, type DraftCommandConfig, fetchAgentCommands } from "./use-query";

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
  it("rejects a discovery error so a previous catalog is retained", async () => {
    const client = createClient({ ...commandsPayload([]), error: "provider unavailable" });
    await expect(fetchAgentCommands({ client, agentId: "agent-1" })).rejects.toThrow(
      "provider unavailable",
    );
  });
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
