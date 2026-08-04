import { describe, expect, it, vi } from "vitest";

import { registerLiveVoiceRoutingTools } from "./live-voice-routing-tools.js";
import type { LiveVoiceRouteResult } from "./live-voice-route-broker.js";
import type { VoiceLiveRouteOperation } from "@getpaseo/protocol/live-voice-routing";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";

const HOST_AGENT_ID = "voice-host";

interface RegisteredTool {
  config: PaseoToolConfig;
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

type RouteExecute = (
  hostAgentId: string,
  operation: VoiceLiveRouteOperation,
  options?: { timeoutMs?: number },
) => Promise<LiveVoiceRouteResult>;

function host(
  overrides: Partial<{
    serverId: string;
    label: string;
    compatibility: "ready" | "offline" | "upgrade_required";
  }> = {},
) {
  return {
    serverId: "server-a",
    label: "Desktop",
    hostname: "desktop",
    version: "1.0.0",
    online: true,
    toolExecutionSupported: true,
    compatibility: "ready" as const,
    agentNotificationsSupported: true,
    ...overrides,
  };
}

function workspaceListing(
  workspaces: Array<{ workspaceId: string; title?: string; cwd?: string }>,
) {
  return {
    kind: "execute_tool" as const,
    targetServerId: "server-a",
    toolResult: {
      content: [],
      structuredContent: {
        workspaces: workspaces.map((workspace) => ({
          workspaceId: workspace.workspaceId,
          projectId: "project-1",
          cwd: workspace.cwd ?? `/work/${workspace.workspaceId}`,
          isolation: "local",
          kind: "directory",
          title: workspace.title ?? null,
        })),
      },
    },
  };
}

function register(execute: RouteExecute): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  registerLiveVoiceRoutingTools({
    hostAgentId: HOST_AGENT_ID,
    broker: { execute: execute as never },
    registerTool: (name, config, handler) => {
      registered.set(name, { config, handler });
    },
  });
  return registered;
}

async function findWorkspace(
  execute: RouteExecute,
  input: { query: string; serverId?: string },
): Promise<Record<string, unknown>> {
  const tool = register(execute).get("find_workspace");
  if (!tool) {
    throw new Error("find_workspace was not registered");
  }
  const result = await tool.handler(input, {});
  return result.structuredContent as Record<string, unknown>;
}

describe("find_workspace", () => {
  it("resolves a spoken workspace name across every ready host in one call", async () => {
    const execute = vi.fn<RouteExecute>(async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [host(), host({ serverId: "server-b", label: "Laptop" })],
        };
      }
      return operation.targetServerId === "server-a"
        ? workspaceListing([{ workspaceId: "ws-1", title: "Live voice routing" }])
        : {
            ...workspaceListing([{ workspaceId: "ws-2", title: "Refresh Paseo assembly" }]),
            targetServerId: "server-b",
          };
    });

    const result = await findWorkspace(execute, { query: "Refresh Paseo assembly" });

    expect(result).toMatchObject({
      resolution: "unique_exact",
      matches: [
        {
          serverId: "server-b",
          hostLabel: "Laptop",
          workspaceId: "ws-2",
          title: "Refresh Paseo assembly",
          matchKind: "exact",
        },
      ],
      unavailableHosts: [],
    });
    // One host lookup, then one listing per host — no per-host discovery turn.
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.filter(([, operation]) => operation.kind === "execute_tool")).toEqual(
      [
        [
          HOST_AGENT_ID,
          {
            kind: "execute_tool",
            targetServerId: "server-a",
            toolName: "list_workspaces",
            arguments: {},
          },
          { timeoutMs: 30_000 },
        ],
        [
          HOST_AGENT_ID,
          {
            kind: "execute_tool",
            targetServerId: "server-b",
            toolName: "list_workspaces",
            arguments: {},
          },
          { timeoutMs: 30_000 },
        ],
      ],
    );
  });

  it("queries the hosts concurrently rather than one after another", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const execute: RouteExecute = async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [
            host(),
            host({ serverId: "server-b", label: "Laptop" }),
            host({ serverId: "server-c", label: "Server" }),
          ],
        };
      }
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return workspaceListing([{ workspaceId: `ws-${operation.targetServerId}` }]);
    };

    await findWorkspace(execute, { query: "anything" });

    expect(peakInFlight).toBe(3);
  });

  it("never picks between two workspaces that share a name", async () => {
    const execute: RouteExecute = async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [host(), host({ serverId: "server-b", label: "Laptop" })],
        };
      }
      return workspaceListing([
        { workspaceId: `ws-${operation.targetServerId}`, title: "Refresh Paseo assembly" },
      ]);
    };

    const result = await findWorkspace(execute, { query: "refresh paseo assembly" });

    expect(result.resolution).toBe("ambiguous_exact");
    expect(result.matches).toHaveLength(2);
  });

  it("reports a host it could not read instead of answering that nothing matched", async () => {
    const execute: RouteExecute = async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [host(), host({ serverId: "server-b", label: "Laptop" })],
        };
      }
      if (operation.targetServerId === "server-b") {
        throw new Error("The requested target host is offline.");
      }
      return workspaceListing([{ workspaceId: "ws-1", title: "Live voice routing" }]);
    };

    const result = await findWorkspace(execute, { query: "refresh paseo assembly" });

    expect(result).toMatchObject({
      resolution: "none",
      searchedHosts: [{ serverId: "server-a", label: "Desktop" }],
      unavailableHosts: [
        {
          serverId: "server-b",
          label: "Laptop",
          reason: "The requested target host is offline.",
        },
      ],
    });
  });

  it("does not try to run tools on a host that needs upgrading", async () => {
    const execute = vi.fn<RouteExecute>(async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [
            host(),
            host({ serverId: "server-b", label: "Laptop", compatibility: "upgrade_required" }),
            host({ serverId: "server-c", label: "Server", compatibility: "offline" }),
          ],
        };
      }
      return workspaceListing([{ workspaceId: "ws-1", title: "Refresh Paseo assembly" }]);
    });

    const result = await findWorkspace(execute, { query: "refresh paseo assembly" });

    expect(result).toMatchObject({
      resolution: "unique_exact",
      unavailableHosts: [
        { serverId: "server-b", reason: "needs a Paseo upgrade" },
        { serverId: "server-c", reason: "offline" },
      ],
    });
    expect(
      execute.mock.calls.filter(([, operation]) => operation.kind === "execute_tool"),
    ).toHaveLength(1);
  });

  it("searches only the host it was given one", async () => {
    const execute = vi.fn<RouteExecute>(async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [host(), host({ serverId: "server-b", label: "Laptop" })],
        };
      }
      return workspaceListing([{ workspaceId: "ws-1", title: "Refresh Paseo assembly" }]);
    });

    const result = await findWorkspace(execute, {
      query: "refresh paseo assembly",
      serverId: "server-b",
    });

    expect(result).toMatchObject({ resolution: "unique_exact" });
    expect(
      execute.mock.calls
        .filter(([, operation]) => operation.kind === "execute_tool")
        .map(([, operation]) =>
          operation.kind === "execute_tool" ? operation.targetServerId : "",
        ),
    ).toEqual(["server-b"]);
  });

  it("rejects a host id that is not the user's", async () => {
    const execute: RouteExecute = async () => ({ kind: "list_hosts", hosts: [host()] });

    await expect(
      findWorkspace(execute, { query: "anything", serverId: "server-x" }),
    ).rejects.toThrow(/Unknown host 'server-x'/);
  });

  it("survives a host that answers with no workspace list at all", async () => {
    const execute: RouteExecute = async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return { kind: "list_hosts", hosts: [host()] };
      }
      return {
        kind: "execute_tool",
        targetServerId: "server-a",
        toolResult: { content: [], structuredContent: { unexpected: true } },
      };
    };

    const result = await findWorkspace(execute, { query: "anything" });

    expect(result).toMatchObject({ resolution: "none", searchedHosts: [{ serverId: "server-a" }] });
  });
});

describe("live voice routing tool catalog", () => {
  it("tells the model to resolve a named workspace before acting on it", () => {
    const registered = register(async () => ({ kind: "list_hosts", hosts: [] }));

    expect(Array.from(registered.keys())).toEqual([
      "list_hosts",
      "find_workspace",
      "list_paseo_tools_on_host",
      "run_paseo_tool_on_host",
    ]);
    expect(registered.get("run_paseo_tool_on_host")?.config.description).toContain(
      "find_workspace",
    );
    // Discovery is the fallback now, not the required first step.
    expect(registered.get("run_paseo_tool_on_host")?.config.description).not.toMatch(
      /Call list_hosts and list_paseo_tools_on_host first/,
    );
    expect(registered.get("find_workspace")?.config.description).toContain("unique_exact");
  });
});
