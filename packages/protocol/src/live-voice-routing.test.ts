import { describe, expect, test } from "vitest";
import { CLIENT_CAPS } from "./client-capabilities.js";
import {
  VoiceLiveRouteRequestSchema,
  VoiceLiveRouteResponseSchema,
  VoiceLiveToolExecuteRequestSchema,
  VoiceLiveToolExecuteResponseSchema,
} from "./live-voice-routing.js";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
} from "./messages.js";

describe("Live Voice cross-host routing protocol", () => {
  test("keeps new client and daemon capabilities optional", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "client-1",
        clientType: "mobile",
        protocolVersion: 1,
      }).capabilities,
    ).toBeUndefined();
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "client-1",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { [CLIENT_CAPS.liveVoiceCrossHostRouter]: true },
      }).capabilities?.[CLIENT_CAPS.liveVoiceCrossHostRouter],
    ).toBe(true);
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.liveVoiceToolExecution,
    ).toBeUndefined();
  });

  test("parses both route operations through the outbound session union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "voice.live.route.request",
        requestId: "route-1",
        liveSessionId: "live-1",
        operation: { kind: "list_hosts" },
      }),
    ).toEqual({
      type: "voice.live.route.request",
      requestId: "route-1",
      liveSessionId: "live-1",
      operation: { kind: "list_hosts" },
    });

    expect(
      VoiceLiveRouteRequestSchema.parse({
        type: "voice.live.route.request",
        requestId: "route-2",
        liveSessionId: "live-1",
        operation: {
          kind: "execute_tool",
          targetServerId: "server-2",
          toolName: "list_agents",
          arguments: { status: "running", nested: [true, null, 2] },
        },
      }).operation,
    ).toMatchObject({
      kind: "execute_tool",
      targetServerId: "server-2",
      toolName: "list_agents",
    });
  });

  test("parses sanitized host and JSON-safe tool results", () => {
    const response = SessionInboundMessageSchema.parse({
      type: "voice.live.route.response",
      payload: {
        requestId: "route-1",
        liveSessionId: "live-1",
        ok: true,
        result: {
          kind: "list_hosts",
          hosts: [
            {
              serverId: "server-2",
              label: "Desktop",
              hostname: "desktop.local",
              version: "0.2.5",
              online: true,
              toolExecutionSupported: true,
            },
          ],
        },
      },
    });
    expect(response).toEqual({
      type: "voice.live.route.response",
      payload: {
        requestId: "route-1",
        liveSessionId: "live-1",
        ok: true,
        result: {
          kind: "list_hosts",
          hosts: [
            {
              serverId: "server-2",
              label: "Desktop",
              hostname: "desktop.local",
              version: "0.2.5",
              online: true,
              toolExecutionSupported: true,
            },
          ],
        },
      },
    });

    expect(
      VoiceLiveToolExecuteResponseSchema.parse({
        type: "voice.live.tool.execute.response",
        payload: {
          requestId: "tool-1",
          ok: true,
          toolResult: {
            content: [{ type: "text", text: "done" }],
            structuredContent: { changed: true },
            isError: false,
          },
        },
      }).payload,
    ).toMatchObject({ ok: true, toolResult: { isError: false } });
  });

  test("accepts future error codes while rejecting non-JSON values", () => {
    expect(
      VoiceLiveRouteResponseSchema.parse({
        type: "voice.live.route.response",
        payload: {
          requestId: "route-1",
          liveSessionId: "live-1",
          ok: false,
          error: {
            code: "a_code_from_a_newer_client",
            message: "Try a newer client.",
          },
        },
      }).payload,
    ).toMatchObject({ ok: false, error: { code: "a_code_from_a_newer_client" } });

    expect(
      VoiceLiveToolExecuteRequestSchema.safeParse({
        type: "voice.live.tool.execute.request",
        requestId: "tool-1",
        toolName: "list_agents",
        arguments: { invalid: undefined },
      }).success,
    ).toBe(false);
  });
  test("keeps work notifications optional in both directions", () => {
    // An older source daemon omits the flag; an older target ignores it.
    expect(
      VoiceLiveToolExecuteRequestSchema.parse({
        type: "voice.live.tool.execute.request",
        requestId: "execute-1",
        toolName: "create_agent",
        arguments: {},
      }).notifyOnAgentFinish,
    ).toBeUndefined();
    expect(
      VoiceLiveRouteRequestSchema.parse({
        type: "voice.live.route.request",
        requestId: "route-1",
        liveSessionId: "live-1",
        operation: {
          kind: "execute_tool",
          targetServerId: "target",
          toolName: "create_agent",
          arguments: {},
        },
      }).operation,
    ).toEqual({
      kind: "execute_tool",
      targetServerId: "target",
      toolName: "create_agent",
      arguments: {},
    });
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.liveVoiceAgentNotifications,
    ).toBeUndefined();
  });

  test("routes a work notification from the target push to the source request", () => {
    const notification = {
      agentId: "agent-1",
      title: "Rebase main",
      // Open on purpose, so a newer daemon can report an outcome this client
      // has never heard of.
      reason: "vanished",
      summary: null,
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "voice.live.agent.update",
        payload: { requestId: "execute-1", notification },
      }),
    ).toEqual({
      type: "voice.live.agent.update",
      payload: { requestId: "execute-1", notification },
    });

    expect(
      SessionInboundMessageSchema.parse({
        type: "voice.live.agent.notify.request",
        requestId: "notify-1",
        liveSessionId: "live-1",
        notification: { ...notification, hostLabel: "Desktop" },
      }),
    ).toMatchObject({ liveSessionId: "live-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "voice.live.agent.notify.response",
        payload: {
          requestId: "notify-1",
          delivered: false,
          error: { code: "unknown_call", message: "no such call" },
        },
      }),
    ).toMatchObject({ payload: { delivered: false } });
  });

  describe("ambient agent reports", () => {
    test("carries the watch request, its response, and the feature that gates it", () => {
      expect(
        SessionInboundMessageSchema.parse({
          type: "voice.live.agent.watch.request",
          requestId: "watch-1",
          enabled: true,
        }),
      ).toMatchObject({ enabled: true });

      expect(
        SessionOutboundMessageSchema.parse({
          type: "voice.live.agent.watch.response",
          payload: {
            requestId: "watch-1",
            enabled: false,
            error: { code: "unsupported", message: "no" },
          },
        }),
      ).toMatchObject({ payload: { enabled: false } });

      expect(
        ServerInfoStatusPayloadSchema.parse({
          status: "server_info",
          serverId: "server-1",
          features: {},
        }).features?.liveVoiceAmbientAgentReports,
      ).toBeUndefined();
    });

    test("a start request without the new fields still parses", () => {
      // An older app never sends them; the daemon must not require them.
      expect(
        SessionInboundMessageSchema.parse({
          type: "voice.live.start.request",
          requestId: "start-1",
          offerSdp: "v=0",
        }),
      ).toMatchObject({ requestId: "start-1" });

      expect(
        SessionInboundMessageSchema.parse({
          type: "voice.live.start.request",
          requestId: "start-1",
          offerSdp: "v=0",
          ambientAgentReports: true,
          ambientAgentGuidance: "Only interrupt for permissions.",
        }),
      ).toMatchObject({ ambientAgentReports: true });
    });

    test("an older client's notification still parses, and a newer one's survives the round trip", () => {
      const base = {
        agentId: "agent-1",
        title: "Nightly bump",
        reason: "turn_completed",
        summary: null,
      };

      // `unsolicited` is a new optional field, so its absence is normal traffic.
      expect(
        SessionOutboundMessageSchema.parse({
          type: "voice.live.agent.update",
          payload: { requestId: "execute-1", notification: base },
        }),
      ).toMatchObject({ payload: { notification: { agentId: "agent-1" } } });

      expect(
        SessionOutboundMessageSchema.parse({
          type: "voice.live.agent.update",
          payload: { requestId: "ambient-1", notification: { ...base, unsolicited: true } },
        }),
      ).toMatchObject({ payload: { notification: { unsolicited: true } } });
    });
  });
});
