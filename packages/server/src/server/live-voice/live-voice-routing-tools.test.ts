import { describe, expect, it, vi } from "vitest";

import { registerLiveVoiceRoutingTools } from "./live-voice-routing-tools.js";
import { LIVE_VOICE_ALL_HOSTS_READ_TOOLS } from "./live-voice-fanout-tools.js";
import {
  LiveVoiceRoutedRequestError,
  type LiveVoiceRouteResult,
} from "./live-voice-route-broker.js";
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
          { timeoutMs: 5_000 },
        ],
        [
          HOST_AGENT_ID,
          {
            kind: "execute_tool",
            targetServerId: "server-b",
            toolName: "list_workspaces",
            arguments: {},
          },
          { timeoutMs: 5_000 },
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

  it("reports an unreadable workspace list as an error, never as an empty host", async () => {
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

    // A version-skewed host must not silently hide the workspace the user named.
    expect(result).toMatchObject({
      resolution: "none",
      searchedHosts: [],
      erroredHosts: [
        { serverId: "server-a", reason: "returned a workspace list this call could not read" },
      ],
    });
  });

  it("reuses the host list across fan-outs instead of refetching it each time", async () => {
    const execute = vi.fn<RouteExecute>(async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return { kind: "list_hosts", hosts: [host()] };
      }
      return workspaceListing([{ workspaceId: "ws-1", title: "Refresh Paseo assembly" }]);
    });
    const registered = register(execute);
    const findTool = registered.get("find_workspace");
    if (!findTool) {
      throw new Error("find_workspace was not registered");
    }

    await findTool.handler({ query: "refresh paseo assembly" }, {});
    await findTool.handler({ query: "refresh paseo assembly" }, {});

    // The second fan-out starts on its targets immediately: no serial host
    // lookup through the owning app in front of it.
    const hostLookups = execute.mock.calls.filter(
      ([, operation]) => operation.kind === "list_hosts",
    );
    expect(hostLookups).toHaveLength(1);
  });

  it("refreshes the host list when asked for a host the cache has never seen", async () => {
    let hostLookups = 0;
    const execute: RouteExecute = async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        hostLookups += 1;
        return {
          kind: "list_hosts",
          hosts:
            hostLookups === 1 ? [host()] : [host(), host({ serverId: "server-new", label: "New" })],
        };
      }
      return {
        ...workspaceListing([{ workspaceId: "ws-new", title: "Refresh Paseo assembly" }]),
        targetServerId: operation.targetServerId,
      };
    };
    const registered = register(execute);
    const findTool = registered.get("find_workspace");
    if (!findTool) {
      throw new Error("find_workspace was not registered");
    }

    // Warm the cache without the new host, then name it explicitly.
    await findTool.handler({ query: "anything" }, {});
    const result = await findTool.handler(
      { query: "refresh paseo assembly", serverId: "server-new" },
      {},
    );

    expect(hostLookups).toBe(2);
    expect((result.structuredContent as { resolution: string }).resolution).toBe("unique_exact");
  });

  it("always fetches fresh hosts when the model calls list_hosts explicitly", async () => {
    const execute = vi.fn<RouteExecute>(async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return { kind: "list_hosts", hosts: [host()] };
      }
      return workspaceListing([{ workspaceId: "ws-1" }]);
    });
    const registered = register(execute);
    const findTool = registered.get("find_workspace");
    const listTool = registered.get("list_hosts");
    if (!findTool || !listTool) {
      throw new Error("routing tools were not registered");
    }

    await findTool.handler({ query: "anything" }, {});
    await listTool.handler({}, {});

    const hostLookups = execute.mock.calls.filter(
      ([, operation]) => operation.kind === "list_hosts",
    );
    expect(hostLookups).toHaveLength(2);
  });
});

async function runOnAllHosts(
  execute: RouteExecute,
  input: { toolName: string; arguments?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const tool = register(execute).get("run_paseo_tool_on_all_hosts");
  if (!tool) {
    throw new Error("run_paseo_tool_on_all_hosts was not registered");
  }
  const result = await tool.handler(input, {});
  return result.structuredContent as Record<string, unknown>;
}

describe("run_paseo_tool_on_all_hosts", () => {
  it("answers a question about every machine in a single call", async () => {
    const execute = vi.fn<RouteExecute>(async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [host(), host({ serverId: "server-b", label: "Laptop" })],
        };
      }
      return {
        kind: "execute_tool",
        targetServerId: operation.targetServerId,
        toolResult: {
          content: [],
          structuredContent: { agents: [{ id: `agent-${operation.targetServerId}` }] },
        },
      };
    });

    const result = await runOnAllHosts(execute, { toolName: "list_agents" });

    expect(result).toMatchObject({
      toolName: "list_agents",
      results: [
        {
          serverId: "server-a",
          hostLabel: "Desktop",
          result: { agents: [{ id: "agent-server-a" }] },
        },
        {
          serverId: "server-b",
          hostLabel: "Laptop",
          result: { agents: [{ id: "agent-server-b" }] },
        },
      ],
      unavailableHosts: [],
    });
    // One turn for the model: the host lookup plus one read per host.
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("passes the same arguments to every host", async () => {
    const execute = vi.fn<RouteExecute>(async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [host(), host({ serverId: "server-b", label: "Laptop" })],
        };
      }
      return {
        kind: "execute_tool",
        targetServerId: operation.targetServerId,
        toolResult: { content: [], structuredContent: {} },
      };
    });

    await runOnAllHosts(execute, {
      toolName: "get_agent_status",
      arguments: { agentId: "agent-1" },
    });

    expect(
      execute.mock.calls
        .filter(([, operation]) => operation.kind === "execute_tool")
        .map(([, operation]) => (operation.kind === "execute_tool" ? operation.arguments : null)),
    ).toEqual([{ agentId: "agent-1" }, { agentId: "agent-1" }]);
  });

  it("refuses to fan a mutating tool out across every machine", async () => {
    const execute = vi.fn<RouteExecute>(async () => ({ kind: "list_hosts", hosts: [host()] }));

    await expect(runOnAllHosts(execute, { toolName: "archive_workspace" })).rejects.toThrow(
      /cannot be run on every host at once/,
    );
    // It must not reach a single host either — the refusal is total.
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["archive_workspace", "create_agent", "kill_agent", "send_agent_prompt", "cancel_agent"])(
    "keeps %s off the all-hosts allowlist",
    (toolName) => {
      expect(LIVE_VOICE_ALL_HOSTS_READ_TOOLS).not.toContain(toolName);
    },
  );

  it("reports the hosts it could not reach alongside the ones it did", async () => {
    const execute: RouteExecute = async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [
            host(),
            host({ serverId: "server-b", label: "Laptop" }),
            host({ serverId: "server-c", label: "Server", compatibility: "offline" }),
          ],
        };
      }
      if (operation.targetServerId === "server-b") {
        throw new Error("The requested target host is offline.");
      }
      return {
        kind: "execute_tool",
        targetServerId: operation.targetServerId,
        toolResult: { content: [], structuredContent: { agents: [] } },
      };
    };

    const result = await runOnAllHosts(execute, { toolName: "list_agents" });

    expect(result).toMatchObject({
      results: [{ serverId: "server-a" }],
      unavailableHosts: [
        { serverId: "server-c", reason: "offline" },
        { serverId: "server-b", reason: "The requested target host is offline." },
      ],
      erroredHosts: [],
    });
  });

  it("tells a tool failure apart from an unreachable machine", async () => {
    // The legitimate way to learn which machine owns an agent: fan the id out
    // and expect a clean failure everywhere but one. Those failures must not be
    // narrated as machines being down.
    const execute: RouteExecute = async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [host(), host({ serverId: "server-b", label: "Laptop" })],
        };
      }
      if (operation.targetServerId === "server-b") {
        throw new LiveVoiceRoutedRequestError("Agent not found: agent-1", {
          code: "tool_execution_failed",
        });
      }
      return {
        kind: "execute_tool",
        targetServerId: operation.targetServerId,
        toolResult: { content: [], structuredContent: { status: "running" } },
      };
    };

    const result = await runOnAllHosts(execute, {
      toolName: "get_agent_status",
      arguments: { agentId: "agent-1" },
    });

    expect(result).toMatchObject({
      results: [{ serverId: "server-a", result: { status: "running" } }],
      unavailableHosts: [],
      erroredHosts: [{ serverId: "server-b", reason: "Agent not found: agent-1" }],
    });
  });

  it("classifies connectivity codes as unreachable and unknown codes as tool failures", async () => {
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
      if (operation.targetServerId === "server-a") {
        throw new LiveVoiceRoutedRequestError("The requested target host is offline.", {
          code: "host_offline",
          retryable: true,
        });
      }
      if (operation.targetServerId === "server-b") {
        // A code this daemon has never heard of. Claiming an outage it cannot
        // see would be the worse guess, so it reads as a tool failure.
        throw new LiveVoiceRoutedRequestError("Novel failure", { code: "sandbox_denied" });
      }
      return {
        kind: "execute_tool",
        targetServerId: operation.targetServerId,
        toolResult: { content: [], structuredContent: { agents: [] } },
      };
    };

    const result = await runOnAllHosts(execute, { toolName: "list_agents" });

    expect(result).toMatchObject({
      unavailableHosts: [{ serverId: "server-a", reason: "The requested target host is offline." }],
      erroredHosts: [{ serverId: "server-b", reason: "Novel failure" }],
    });
  });

  it("reports a result flagged isError as a tool failure with its own words", async () => {
    const execute: RouteExecute = async (_hostAgentId, operation) => {
      if (operation.kind === "list_hosts") {
        return {
          kind: "list_hosts",
          hosts: [host(), host({ serverId: "server-b", label: "Laptop" })],
        };
      }
      if (operation.targetServerId === "server-b") {
        return {
          kind: "execute_tool",
          targetServerId: "server-b",
          toolResult: {
            content: [{ type: "text", text: "schedule sched-1 does not exist" }],
            isError: true,
          },
        };
      }
      return {
        kind: "execute_tool",
        targetServerId: operation.targetServerId,
        toolResult: { content: [], structuredContent: { schedules: [] } },
      };
    };

    const result = await runOnAllHosts(execute, { toolName: "list_schedules" });

    expect(result).toMatchObject({
      results: [{ serverId: "server-a" }],
      erroredHosts: [{ serverId: "server-b", reason: "schedule sched-1 does not exist" }],
    });
  });
});

describe("live voice routing tool catalog", () => {
  it("tells the model to resolve a named workspace before acting on it", () => {
    const registered = register(async () => ({ kind: "list_hosts", hosts: [] }));

    expect(Array.from(registered.keys())).toEqual([
      "list_hosts",
      "find_workspace",
      "run_paseo_tool_on_all_hosts",
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
