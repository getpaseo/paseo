import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  removeAgentFromHistoryCache,
  removeAgentFromHistoryPayload,
  type DeleteAgentInput,
} from "./use-delete-agent";
import { agentHistoryQueryKey } from "./agent-history-query-key";

describe("removeAgentFromHistoryPayload", () => {
  const input: DeleteAgentInput = { serverId: "server-a", agentId: "agent-1" };

  function makePayload() {
    return {
      pages: [
        {
          agents: [{ id: "agent-1", serverId: "server-a" }, { id: "agent-2", serverId: "server-a" }],
        },
        {
          agents: [{ id: "agent-3", serverId: "server-a" }],
        },
      ],
    };
  }

  it("removes the agent from every page that contains it", () => {
    const result = removeAgentFromHistoryPayload(makePayload(), input);
    const remaining = result?.pages?.flatMap((page) => page.agents ?? []);
    expect(remaining).toEqual([{ id: "agent-2", serverId: "server-a" }, { id: "agent-3", serverId: "server-a" }]);
  });

  it("leaves agents from other servers untouched", () => {
    const payload = {
      pages: [{ agents: [{ id: "agent-1", serverId: "server-b" }, { id: "agent-2", serverId: "server-a" }] }],
    };
    const result = removeAgentFromHistoryPayload(payload, input);
    expect(result?.pages?.[0]?.agents).toEqual([
      { id: "agent-1", serverId: "server-b" },
      { id: "agent-2", serverId: "server-a" },
    ]);
  });

  it("returns the same payload when the agent is absent", () => {
    const payload = makePayload();
    const otherInput: DeleteAgentInput = { serverId: "server-a", agentId: "nope" };
    expect(removeAgentFromHistoryPayload(payload, otherInput)).toBe(payload);
  });

  it("handles undefined and empty payloads", () => {
    expect(removeAgentFromHistoryPayload(undefined, input)).toBeUndefined();
    expect(removeAgentFromHistoryPayload({ pages: [] }, input)).toEqual({ pages: [] });
  });
});

describe("removeAgentFromHistoryCache", () => {
  it("patches the per-server history query and the all-history queries", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(agentHistoryQueryKey("server-a"), {
      pages: [{ agents: [{ id: "agent-1", serverId: "server-a" }] }],
    });
    queryClient.setQueryData(["allAgentHistory", ["server-a"]], {
      pages: [{ agents: [{ id: "agent-1", serverId: "server-a" }] }],
    });

    removeAgentFromHistoryCache(queryClient, { serverId: "server-a", agentId: "agent-1" });

    expect(queryClient.getQueryData(agentHistoryQueryKey("server-a"))).toEqual({
      pages: [{ agents: [] }],
    });
    expect(queryClient.getQueryData(["allAgentHistory", ["server-a"]])).toEqual({
      pages: [{ agents: [] }],
    });
  });
});