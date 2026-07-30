import { describe, expect, test, vi } from "vitest";
import type {
  VoiceLiveRouteRequest,
  VoiceLiveRouteResponse,
  VoiceLiveToolResult,
} from "@getpaseo/protocol/live-voice-routing";
import {
  type DaemonClient,
  LiveVoiceToolExecutionRejectedError,
  type LiveVoiceRouteRequestMessage,
} from "@getpaseo/client/internal/daemon-client";
import {
  mountLiveVoiceCrossHostRouter,
  type LiveVoiceCrossHostRouterDeps,
} from "./live-voice-cross-host-router";

function createSourceClient() {
  let handler: ((request: LiveVoiceRouteRequestMessage) => void) | null = null;
  const responses: VoiceLiveRouteResponse[] = [];
  return {
    responses,
    client: {
      on(
        _type: "voice.live.route.request",
        nextHandler: (request: LiveVoiceRouteRequestMessage) => void,
      ) {
        handler = nextHandler;
        return () => {
          handler = null;
        };
      },
      sendLiveVoiceRouteResponse(response: VoiceLiveRouteResponse) {
        responses.push(response);
      },
    } as unknown as Pick<DaemonClient, "on" | "sendLiveVoiceRouteResponse">,
    request(request: VoiceLiveRouteRequest) {
      handler?.(request);
    },
  };
}

function createDeps(input?: {
  execute?: () => Promise<VoiceLiveToolResult>;
  authorized?: boolean;
  pinAvailable?: boolean;
  toolExecutionSupported?: boolean;
}) {
  const release = vi.fn();
  const executeLiveVoiceTool = vi.fn(
    input?.execute ??
      (async () => ({
        content: [{ type: "text", text: "done" }],
        structuredContent: { changed: true },
        isError: false,
      })),
  );
  const deps: LiveVoiceCrossHostRouterDeps = {
    getSavedHosts: () => [
      { serverId: "source", label: " Voice laptop " },
      { serverId: "target", label: " Desktop " },
      { serverId: "offline", label: "Offline" },
    ],
    getHostRuntimeSnapshot: (serverId) => ({
      connectionStatus: serverId === "offline" ? "offline" : "online",
    }),
    getHostServerInfo: (serverId) => ({
      hostname: serverId === "target" ? " desktop.local " : null,
      version: serverId === "target" ? " 0.2.5 " : null,
      features: {
        liveVoiceToolExecution:
          serverId !== "offline" &&
          (serverId !== "target" || input?.toolExecutionSupported !== false),
      },
    }),
    pinActiveConnection: () =>
      input?.pinAvailable === false
        ? null
        : {
            client: { executeLiveVoiceTool },
            release,
          },
    isAuthorizedSourceCall: (serverId, liveSessionId) =>
      input?.authorized !== false && serverId === "source" && liveSessionId === "live-1",
  };
  return { deps, executeLiveVoiceTool, release };
}

function routeRequest(
  operation: VoiceLiveRouteRequest["operation"],
  overrides?: Partial<Pick<VoiceLiveRouteRequest, "liveSessionId" | "requestId">>,
): VoiceLiveRouteRequest {
  return {
    type: "voice.live.route.request",
    requestId: overrides?.requestId ?? "route-1",
    liveSessionId: overrides?.liveSessionId ?? "live-1",
    operation,
  };
}

describe("Live Voice cross-host router", () => {
  test("lists only sanitized saved-host metadata", async () => {
    const source = createSourceClient();
    const { deps } = createDeps();
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
    });

    source.request(routeRequest({ kind: "list_hosts" }));
    await vi.waitFor(() => {
      expect(source.responses).toHaveLength(1);
    });

    expect(source.responses[0]).toEqual({
      type: "voice.live.route.response",
      payload: {
        requestId: "route-1",
        liveSessionId: "live-1",
        ok: true,
        result: {
          kind: "list_hosts",
          hosts: [
            {
              serverId: "source",
              label: "Voice laptop",
              hostname: null,
              version: null,
              online: true,
              toolExecutionSupported: true,
            },
            {
              serverId: "target",
              label: "Desktop",
              hostname: "desktop.local",
              version: "0.2.5",
              online: true,
              toolExecutionSupported: true,
            },
            {
              serverId: "offline",
              label: "Offline",
              hostname: null,
              version: null,
              online: false,
              toolExecutionSupported: false,
            },
          ],
        },
      },
    });
    expect(JSON.stringify(source.responses[0])).not.toContain("connections");
    expect(JSON.stringify(source.responses[0])).not.toContain("password");
    expect(JSON.stringify(source.responses[0])).not.toContain("daemonPublicKey");
  });

  test.each([
    {
      name: "a source without the active call",
      depsInput: { authorized: false },
      operation: { kind: "list_hosts" } as const,
      code: "unauthorized_source_call",
    },
    {
      name: "a mismatched live session",
      depsInput: {},
      liveSessionId: "wrong-live-session",
      operation: { kind: "list_hosts" } as const,
      code: "unauthorized_source_call",
    },
    {
      name: "an unknown host",
      depsInput: {},
      operation: {
        kind: "execute_tool",
        targetServerId: "unknown",
        toolName: "list_agents",
        arguments: {},
      } as const,
      code: "unknown_host",
    },
    {
      name: "an offline host",
      depsInput: {},
      operation: {
        kind: "execute_tool",
        targetServerId: "offline",
        toolName: "list_agents",
        arguments: {},
      } as const,
      code: "host_offline",
    },
    {
      name: "a host without tool execution support",
      depsInput: { toolExecutionSupported: false },
      operation: {
        kind: "execute_tool",
        targetServerId: "target",
        toolName: "list_agents",
        arguments: {},
      } as const,
      code: "tool_execution_unsupported",
    },
    {
      name: "a host whose connection cannot be pinned",
      depsInput: { pinAvailable: false },
      operation: {
        kind: "execute_tool",
        targetServerId: "target",
        toolName: "list_agents",
        arguments: {},
      } as const,
      code: "host_offline",
    },
  ])("rejects $name before execution", async ({ depsInput, operation, liveSessionId, code }) => {
    const source = createSourceClient();
    const { deps, executeLiveVoiceTool } = createDeps(depsInput);
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
    });

    source.request(routeRequest(operation, liveSessionId ? { liveSessionId } : {}));
    await vi.waitFor(() => {
      expect(source.responses).toHaveLength(1);
    });

    expect(source.responses[0]?.payload).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(executeLiveVoiceTool).not.toHaveBeenCalled();
  });

  test("executes on the captured pinned client and releases it after success", async () => {
    const source = createSourceClient();
    const { deps, executeLiveVoiceTool, release } = createDeps();
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
    });

    source.request(
      routeRequest({
        kind: "execute_tool",
        targetServerId: "target",
        toolName: "list_agents",
        arguments: { status: "running" },
      }),
    );
    await vi.waitFor(() => {
      expect(source.responses).toHaveLength(1);
    });

    expect(executeLiveVoiceTool).toHaveBeenCalledExactlyOnceWith({
      toolName: "list_agents",
      arguments: { status: "running" },
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(source.responses[0]?.payload).toEqual({
      requestId: "route-1",
      liveSessionId: "live-1",
      ok: true,
      result: {
        kind: "execute_tool",
        targetServerId: "target",
        toolResult: {
          content: [{ type: "text", text: "done" }],
          structuredContent: { changed: true },
          isError: false,
        },
      },
    });
  });

  test("can route back through the pinned source-host connection", async () => {
    const source = createSourceClient();
    const { deps, executeLiveVoiceTool, release } = createDeps();
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
    });

    source.request(
      routeRequest({
        kind: "execute_tool",
        targetServerId: "source",
        toolName: "list_agents",
        arguments: {},
      }),
    );
    await vi.waitFor(() => {
      expect(source.responses).toHaveLength(1);
    });

    expect(executeLiveVoiceTool).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(source.responses[0]?.payload).toMatchObject({
      ok: true,
      result: {
        kind: "execute_tool",
        targetServerId: "source",
      },
    });
  });

  test("preserves target rejections and releases the pin in finally", async () => {
    const source = createSourceClient();
    const { deps, release } = createDeps({
      execute: async () => {
        throw new LiveVoiceToolExecutionRejectedError({
          code: "tool_not_found",
          message: "No such Paseo tool.",
        });
      },
    });
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
    });

    source.request(
      routeRequest({
        kind: "execute_tool",
        targetServerId: "target",
        toolName: "missing_tool",
        arguments: {},
      }),
    );
    await vi.waitFor(() => {
      expect(source.responses).toHaveLength(1);
    });

    expect(source.responses[0]?.payload).toMatchObject({
      ok: false,
      error: {
        code: "tool_not_found",
        message: "No such Paseo tool.",
        retryable: false,
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
