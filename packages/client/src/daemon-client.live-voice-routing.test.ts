import { afterEach, describe, expect, test } from "vitest";
import type { VoiceLiveRouteRequest } from "@getpaseo/protocol/live-voice-routing";
import {
  DaemonClient,
  LiveVoiceToolExecutionRejectedError,
  type DaemonTransport,
} from "./daemon-client.js";

function createTransportHarness() {
  const sent: string[] = [];
  let onMessage: (data: unknown) => void = () => {};
  let onOpen: () => void = () => {};

  const transport: DaemonTransport = {
    send: (data) => {
      if (typeof data === "string") {
        sent.push(data);
      }
    },
    close: () => {},
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: () => () => {},
    onError: () => () => {},
  };

  return {
    sent,
    transport,
    open() {
      onOpen();
      onMessage(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "server-1",
              hostname: "host-1",
              version: "0.2.5",
              features: { liveVoiceToolExecution: true },
            },
          },
        }),
      );
      sent.length = 0;
    },
    receive(message: unknown) {
      onMessage(JSON.stringify({ type: "session", message }));
    },
  };
}

function parseSentMessage(frame: string | undefined): Record<string, unknown> {
  if (!frame) {
    throw new Error("Expected a sent frame");
  }
  return (JSON.parse(frame) as { message: Record<string, unknown> }).message;
}

const clients: DaemonClient[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
});

async function createConnectedClient() {
  const harness = createTransportHarness();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "live_voice_router_test",
    transportFactory: () => harness.transport,
    reconnect: { enabled: false },
  });
  clients.push(client);
  const connected = client.connect();
  harness.open();
  await connected;
  return { client, harness };
}

describe("DaemonClient Live Voice cross-host routing", () => {
  test("executes a tool through the correlated target-host RPC", async () => {
    const { client, harness } = await createConnectedClient();

    const resultPromise = client.executeLiveVoiceTool({
      requestId: "tool-1",
      toolName: "list_agents",
      arguments: { status: "running" },
    });
    expect(parseSentMessage(harness.sent[0])).toEqual({
      type: "voice.live.tool.execute.request",
      requestId: "tool-1",
      toolName: "list_agents",
      arguments: { status: "running" },
    });

    harness.receive({
      type: "voice.live.tool.execute.response",
      payload: {
        requestId: "tool-1",
        ok: true,
        toolResult: {
          content: [{ type: "text", text: "one agent" }],
          structuredContent: { count: 1 },
          isError: false,
        },
        backgroundAgentId: "agent-1",
      },
    });

    await expect(resultPromise).resolves.toEqual({
      toolResult: {
        content: [{ type: "text", text: "one agent" }],
        structuredContent: { count: 1 },
        isError: false,
      },
      backgroundAgentId: "agent-1",
    });
  });

  test("preserves target-host rejection codes", async () => {
    const { client, harness } = await createConnectedClient();

    const resultPromise = client.executeLiveVoiceTool({
      requestId: "tool-2",
      toolName: "missing_tool",
      arguments: {},
    });
    harness.receive({
      type: "voice.live.tool.execute.response",
      payload: {
        requestId: "tool-2",
        ok: false,
        error: {
          code: "tool_not_found",
          message: "No such Paseo tool.",
          retryable: false,
        },
      },
    });

    await expect(resultPromise).rejects.toMatchObject<LiveVoiceToolExecutionRejectedError>({
      name: "LiveVoiceToolExecutionRejectedError",
      errorCode: "tool_not_found",
      message: "No such Paseo tool.",
      retryable: false,
    });
  });

  test("receives route requests and replies on the source client", async () => {
    const { client, harness } = await createConnectedClient();
    let received: VoiceLiveRouteRequest | null = null;
    const unsubscribe = client.on("voice.live.route.request", (request) => {
      received = request;
    });

    harness.receive({
      type: "voice.live.route.request",
      requestId: "route-1",
      liveSessionId: "live-1",
      operation: { kind: "list_hosts" },
    });
    expect(received).toEqual({
      type: "voice.live.route.request",
      requestId: "route-1",
      liveSessionId: "live-1",
      operation: { kind: "list_hosts" },
    });

    client.sendLiveVoiceRouteResponse({
      type: "voice.live.route.response",
      payload: {
        requestId: "route-1",
        liveSessionId: "live-1",
        ok: true,
        result: { kind: "list_hosts", hosts: [] },
      },
    });
    expect(parseSentMessage(harness.sent[0])).toEqual({
      type: "voice.live.route.response",
      payload: {
        requestId: "route-1",
        liveSessionId: "live-1",
        ok: true,
        result: { kind: "list_hosts", hosts: [] },
      },
    });
    unsubscribe();
  });
});
