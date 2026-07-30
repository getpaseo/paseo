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
});
