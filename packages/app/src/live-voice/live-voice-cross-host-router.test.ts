import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  VoiceLiveAgentUpdate,
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
import {
  forgetAmbientLiveVoiceWatchesForCall,
  resetRoutedLiveVoiceWork,
  trackAmbientLiveVoiceWatch,
} from "./live-voice-work-registry";

function createSourceClient() {
  const handlers = new Map<string, (message: never) => void>();
  const responses: VoiceLiveRouteResponse[] = [];
  return {
    responses,
    client: {
      on(type: string, nextHandler: (message: never) => void) {
        handlers.set(type, nextHandler);
        return () => {
          handlers.delete(type);
        };
      },
      sendLiveVoiceRouteResponse(response: VoiceLiveRouteResponse) {
        responses.push(response);
      },
    } as unknown as Pick<DaemonClient, "on" | "sendLiveVoiceRouteResponse">,
    request(request: VoiceLiveRouteRequest) {
      (
        handlers.get("voice.live.route.request") as
          | ((message: LiveVoiceRouteRequestMessage) => void)
          | undefined
      )?.(request);
    },
    agentUpdate(update: VoiceLiveAgentUpdate) {
      (
        handlers.get("voice.live.agent.update") as
          | ((message: VoiceLiveAgentUpdate) => void)
          | undefined
      )?.(update);
    },
  };
}

function createDeps(input?: {
  execute?: () => Promise<{ toolResult: VoiceLiveToolResult; backgroundAgentId?: string }>;
  authorized?: boolean;
  pinAvailable?: boolean;
  toolExecutionSupported?: boolean;
  agentNotificationsSupported?: boolean;
  sourceAgentNotificationsSupported?: boolean;
  delivered?: boolean;
}) {
  const release = vi.fn();
  const notifyLiveVoiceAgentUpdate = vi.fn(async () => ({
    delivered: input?.delivered !== false,
  }));
  const executeLiveVoiceTool = vi.fn(
    input?.execute ??
      (async () => ({
        toolResult: {
          content: [{ type: "text", text: "done" }],
          structuredContent: { changed: true },
          isError: false,
        },
        backgroundAgentId: "agent-1",
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
        liveVoiceAgentNotifications:
          (serverId === "source"
            ? input?.sourceAgentNotificationsSupported
            : input?.agentNotificationsSupported) !== false,
      },
    }),
    pinActiveConnection: () =>
      input?.pinAvailable === false
        ? null
        : {
            client: { executeLiveVoiceTool, notifyLiveVoiceAgentUpdate },
            release,
          },
    isAuthorizedSourceCall: (serverId, liveSessionId) =>
      input?.authorized !== false && serverId === "source" && liveSessionId === "live-1",
  };
  return { deps, executeLiveVoiceTool, notifyLiveVoiceAgentUpdate, release };
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
  beforeEach(() => {
    resetRoutedLiveVoiceWork();
  });

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
              compatibility: "ready",
              agentNotificationsSupported: true,
            },
            {
              serverId: "target",
              label: "Desktop",
              hostname: "desktop.local",
              version: "0.2.5",
              online: true,
              toolExecutionSupported: true,
              compatibility: "ready",
              agentNotificationsSupported: true,
            },
            {
              serverId: "offline",
              label: "Offline",
              hostname: null,
              version: null,
              online: false,
              toolExecutionSupported: false,
              compatibility: "offline",
              agentNotificationsSupported: true,
            },
          ],
        },
      },
    });
    expect(JSON.stringify(source.responses[0])).not.toContain("connections");
    expect(JSON.stringify(source.responses[0])).not.toContain("password");
    expect(JSON.stringify(source.responses[0])).not.toContain("daemonPublicKey");
  });

  test("marks a host without completion notifications as requiring an upgrade", async () => {
    const source = createSourceClient();
    const { deps } = createDeps({ agentNotificationsSupported: false });
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
    });

    source.request(routeRequest({ kind: "list_hosts" }));
    await vi.waitFor(() => expect(source.responses).toHaveLength(1));

    expect(source.responses[0]?.payload).toMatchObject({
      ok: true,
      result: {
        kind: "list_hosts",
        hosts: expect.arrayContaining([
          expect.objectContaining({
            serverId: "target",
            compatibility: "upgrade_required",
            agentNotificationsSupported: false,
          }),
        ]),
      },
    });
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
      requestId: expect.any(String),
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
  async function routeBackgroundWork(input?: {
    agentNotificationsSupported?: boolean;
    authorized?: boolean;
  }) {
    const source = createSourceClient();
    const harness = createDeps({
      ...(input?.agentNotificationsSupported === false
        ? { agentNotificationsSupported: false }
        : {}),
      ...(input?.authorized === false ? { authorized: false } : {}),
    });
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps: harness.deps,
      createRequestId: () => "execute-1",
    });
    // The report comes back on the target host's own connection, where that
    // host is mounted as a target rather than as the source of a call.
    const target = createSourceClient();
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "target",
      sourceClient: target.client,
      deps: harness.deps,
    });
    source.request(
      routeRequest({
        kind: "execute_tool",
        targetServerId: "target",
        toolName: "create_agent",
        arguments: { background: true },
        notifyOnAgentFinish: true,
      }),
    );
    await vi.waitFor(() => {
      expect(source.responses).toHaveLength(1);
    });
    return { source, target, ...harness };
  }

  const AGENT_UPDATE: VoiceLiveAgentUpdate = {
    type: "voice.live.agent.update",
    payload: {
      requestId: "execute-1",
      notification: {
        agentId: "agent-1",
        title: "Fix the flaky test",
        reason: "turn_completed",
        scope: "agent_turn",
        summary: "Removed the timing dependency.",
      },
    },
  };

  test("asks a capable target to report background work and speaks the report into the call", async () => {
    const { target, executeLiveVoiceTool, notifyLiveVoiceAgentUpdate } =
      await routeBackgroundWork();

    expect(executeLiveVoiceTool).toHaveBeenCalledExactlyOnceWith({
      toolName: "create_agent",
      arguments: { background: true },
      requestId: "execute-1",
      notifyOnAgentFinish: true,
    });

    target.agentUpdate(AGENT_UPDATE);
    await vi.waitFor(() => {
      expect(notifyLiveVoiceAgentUpdate).toHaveBeenCalledTimes(1);
    });
    expect(notifyLiveVoiceAgentUpdate).toHaveBeenCalledWith({
      liveSessionId: "live-1",
      notification: {
        agentId: "agent-1",
        title: "Fix the flaky test",
        reason: "turn_completed",
        scope: "agent_turn",
        summary: "Removed the timing dependency.",
        // The app is the only party that knows what the user calls this machine.
        hostLabel: "Desktop",
      },
    });
  });

  test("rejects requested notifications when either host cannot report", async () => {
    const { source, executeLiveVoiceTool } = await routeBackgroundWork({
      agentNotificationsSupported: false,
    });

    expect(executeLiveVoiceTool).not.toHaveBeenCalled();
    expect(source.responses[0]?.payload).toMatchObject({
      ok: false,
      error: { code: "agent_notifications_unsupported" },
    });
  });

  test("rejects requested notifications when the source host cannot receive them", async () => {
    const source = createSourceClient();
    const { deps, executeLiveVoiceTool } = createDeps({
      sourceAgentNotificationsSupported: false,
    });
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
      createRequestId: () => "execute-1",
    });

    source.request(
      routeRequest({
        kind: "execute_tool",
        targetServerId: "target",
        toolName: "create_agent",
        arguments: { background: true },
        notifyOnAgentFinish: true,
      }),
    );
    await vi.waitFor(() => expect(source.responses).toHaveLength(1));

    expect(executeLiveVoiceTool).not.toHaveBeenCalled();
    expect(source.responses[0]?.payload).toMatchObject({
      ok: false,
      error: { code: "agent_notifications_unsupported" },
    });
  });

  test("forgets correlation when the tool starts no background agent", async () => {
    const source = createSourceClient();
    const { deps, notifyLiveVoiceAgentUpdate } = createDeps({
      execute: async () => ({
        toolResult: { content: [], structuredContent: { agents: [] } },
      }),
    });
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
      createRequestId: () => "execute-1",
    });
    source.request(
      routeRequest({
        kind: "execute_tool",
        targetServerId: "target",
        toolName: "list_agents",
        arguments: {},
        notifyOnAgentFinish: true,
      }),
    );
    await vi.waitFor(() => expect(source.responses).toHaveLength(1));

    source.agentUpdate(AGENT_UPDATE);
    await Promise.resolve();
    expect(notifyLiveVoiceAgentUpdate).not.toHaveBeenCalled();
  });

  test("drops a report once the call it belongs to is no longer owned", async () => {
    const source = createSourceClient();
    let authorized = true;
    const { deps, notifyLiveVoiceAgentUpdate } = createDeps();
    const authorizingDeps: LiveVoiceCrossHostRouterDeps = {
      ...deps,
      isAuthorizedSourceCall: (serverId, liveSessionId) =>
        authorized && serverId === "source" && liveSessionId === "live-1",
    };
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps: authorizingDeps,
      createRequestId: () => "execute-1",
    });
    source.request(
      routeRequest({
        kind: "execute_tool",
        targetServerId: "target",
        toolName: "create_agent",
        arguments: { background: true },
        notifyOnAgentFinish: true,
      }),
    );
    await vi.waitFor(() => {
      expect(source.responses).toHaveLength(1);
    });

    authorized = false;
    source.agentUpdate(AGENT_UPDATE);
    await Promise.resolve();
    expect(notifyLiveVoiceAgentUpdate).not.toHaveBeenCalled();
  });

  test("ignores a report for work this client never routed", async () => {
    const source = createSourceClient();
    const { deps, notifyLiveVoiceAgentUpdate } = createDeps();
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "source",
      sourceClient: source.client,
      deps,
    });

    source.agentUpdate({
      ...AGENT_UPDATE,
      payload: { ...AGENT_UPDATE.payload, requestId: "never-issued" },
    });
    await Promise.resolve();
    expect(notifyLiveVoiceAgentUpdate).not.toHaveBeenCalled();
  });

  test("speaks a report only once", async () => {
    const { target, notifyLiveVoiceAgentUpdate } = await routeBackgroundWork();

    target.agentUpdate(AGENT_UPDATE);
    await vi.waitFor(() => {
      expect(notifyLiveVoiceAgentUpdate).toHaveBeenCalledTimes(1);
    });
    target.agentUpdate(AGENT_UPDATE);
    await Promise.resolve();
    expect(notifyLiveVoiceAgentUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("Live Voice unsolicited reports", () => {
  beforeEach(() => {
    resetRoutedLiveVoiceWork();
  });

  const UNSOLICITED_UPDATE: VoiceLiveAgentUpdate = {
    type: "voice.live.agent.update",
    payload: {
      // Minted by the reporting daemon; it matches no routed call by design.
      requestId: "ambient-9f2c",
      notification: {
        agentId: "agent-7",
        title: "Nightly dependency bump",
        reason: "turn_completed",
        scope: "agent_turn",
        summary: "Bumped 14 packages.",
        unsolicited: true,
      },
    },
  };

  function mountTargetWithAmbientWatch() {
    const target = createSourceClient();
    const harness = createDeps();
    mountLiveVoiceCrossHostRouter({
      sourceServerId: "target",
      sourceClient: target.client,
      deps: harness.deps,
    });
    return { target, ...harness };
  }

  test("speaks a report for an agent the call never started", async () => {
    const { target, notifyLiveVoiceAgentUpdate } = mountTargetWithAmbientWatch();
    trackAmbientLiveVoiceWatch({
      targetServerId: "target",
      sourceServerId: "source",
      liveSessionId: "live-1",
    });

    target.agentUpdate(UNSOLICITED_UPDATE);

    await vi.waitFor(() => {
      expect(notifyLiveVoiceAgentUpdate).toHaveBeenCalledTimes(1);
    });
    expect(notifyLiveVoiceAgentUpdate).toHaveBeenCalledWith({
      liveSessionId: "live-1",
      notification: expect.objectContaining({ agentId: "agent-7", unsolicited: true }),
    });
  });

  test("keeps speaking reports from the same host instead of retiring after one", async () => {
    const { target, notifyLiveVoiceAgentUpdate } = mountTargetWithAmbientWatch();
    trackAmbientLiveVoiceWatch({
      targetServerId: "target",
      sourceServerId: "source",
      liveSessionId: "live-1",
    });

    target.agentUpdate(UNSOLICITED_UPDATE);
    await vi.waitFor(() => expect(notifyLiveVoiceAgentUpdate).toHaveBeenCalledTimes(1));
    target.agentUpdate(UNSOLICITED_UPDATE);

    // A routed report is one-shot because its work ended. An ambient watch
    // covers a whole machine for a whole call, so retiring it after the first
    // report would silence every agent that finished second.
    await vi.waitFor(() => {
      expect(notifyLiveVoiceAgentUpdate).toHaveBeenCalledTimes(2);
    });
  });

  test("ignores a host reporting work this client never asked it to watch", async () => {
    const { target, notifyLiveVoiceAgentUpdate } = mountTargetWithAmbientWatch();

    target.agentUpdate(UNSOLICITED_UPDATE);

    await Promise.resolve();
    expect(notifyLiveVoiceAgentUpdate).not.toHaveBeenCalled();
  });

  test("drops reports once the call they were registered for has ended", async () => {
    const { target, notifyLiveVoiceAgentUpdate } = mountTargetWithAmbientWatch();
    trackAmbientLiveVoiceWatch({
      targetServerId: "target",
      sourceServerId: "source",
      liveSessionId: "live-1",
    });
    forgetAmbientLiveVoiceWatchesForCall("live-1");

    target.agentUpdate(UNSOLICITED_UPDATE);

    await Promise.resolve();
    expect(notifyLiveVoiceAgentUpdate).not.toHaveBeenCalled();
  });
});
