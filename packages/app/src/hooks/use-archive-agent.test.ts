import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { __private__ } from "./use-archive-agent";

describe("useArchiveAgent", () => {
  it("tracks pending archive state in shared react-query cache", () => {
    const queryClient = new QueryClient();

    expect(
      __private__.isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      })
    ).toBe(false);

    __private__.setAgentArchiving({
      queryClient,
      serverId: "server-a",
      agentId: "agent-1",
      isArchiving: true,
    });

    expect(
      __private__.isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      })
    ).toBe(true);
    expect(
      __private__.isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-2",
      })
    ).toBe(false);

    __private__.setAgentArchiving({
      queryClient,
      serverId: "server-a",
      agentId: "agent-1",
      isArchiving: false,
    });

    expect(
      __private__.isAgentArchiving({
        queryClient,
        serverId: "server-a",
        agentId: "agent-1",
      })
    ).toBe(false);
  });
});
