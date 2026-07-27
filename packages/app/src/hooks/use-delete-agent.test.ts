import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { agentHistoryQueryKey } from "./agent-history-query-key";
import { __private__ } from "./use-delete-agent";
import type { AgentHistoryQueryData } from "./use-archive-agent";

const { removeAgentFromHistoryPayload, removeAgentFromHistoryCache } = __private__;

describe("useDeleteAgent history cache helpers", () => {
  it("removes the matching agent from history pages", () => {
    const payload: AgentHistoryQueryData = {
      pages: [
        {
          agents: [
            { id: "agent-1", serverId: "server-a" },
            { id: "agent-2", serverId: "server-a" },
          ],
        },
      ],
    };

    const next = removeAgentFromHistoryPayload(payload, {
      serverId: "server-a",
      agentId: "agent-1",
    });

    expect(next.pages?.[0]?.agents?.map((agent) => agent.id) ?? []).toEqual(["agent-2"]);
  });

  it("updates the react-query history cache", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AgentHistoryQueryData>(agentHistoryQueryKey("server-a"), {
      pages: [
        {
          agents: [
            { id: "agent-1", serverId: "server-a" },
            { id: "agent-2", serverId: "server-a" },
          ],
        },
      ],
    });

    removeAgentFromHistoryCache(queryClient, {
      serverId: "server-a",
      agentId: "agent-1",
    });

    const cached = queryClient.getQueryData<AgentHistoryQueryData>(
      agentHistoryQueryKey("server-a"),
    );
    expect(cached?.pages?.[0]?.agents?.map((agent) => agent.id) ?? []).toEqual(["agent-2"]);
  });
});
