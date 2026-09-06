import { describe, expect, test, vi } from "vitest";
import type {
  SessionOutboundMessage,
  VoiceAppContext,
  VoiceCallOutboundMessage,
} from "@getpaseo/protocol/messages";
import { createVoiceChat, rejectLegacyVoiceMode } from "./index.js";
import type {
  VoiceCallProvider,
  VoiceProviderCall,
  VoiceProviderTerminal,
} from "./internal/provider.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createProviderCall(input?: {
  terminal?: ReturnType<typeof deferred<VoiceProviderTerminal>>;
  onStop?: () => void;
}): VoiceProviderCall {
  const terminal = input?.terminal ?? deferred<VoiceProviderTerminal>();
  let stopped = false;
  return {
    transport: { kind: "webrtc", answerSdp: "answer-sdp" },
    closed: terminal.promise,
    async updateContext() {},
    async handleTransportMessage() {},
    async stop() {
      if (stopped) return;
      stopped = true;
      input?.onStop?.();
      terminal.resolve({ type: "closed" });
    },
  };
}

function startRequest(requestId = "start-1") {
  return {
    type: "voice.call.start.request" as const,
    requestId,
    context: { workspaceId: "workspace-1", agentId: null },
    transports: [{ kind: "webrtc" as const, offerSdp: "offer-sdp" }],
  };
}

function createClient(provider: VoiceCallProvider) {
  const messages: VoiceCallOutboundMessage[] = [];
  const voice = createVoiceChat({ provider });
  const client = voice.openClientSession({
    emit: (message) => messages.push(message),
  });
  return { voice, client, messages };
}

function acceptedCallId(messages: VoiceCallOutboundMessage[], requestId = "start-1"): string {
  const response = messages.find(
    (message) =>
      message.type === "voice.call.start.response" && message.payload.requestId === requestId,
  );
  if (response?.type !== "voice.call.start.response" || !response.payload.callId) {
    throw new Error(`Expected accepted start ${requestId}`);
  }
  return response.payload.callId;
}

describe("voice call provider boundary", () => {
  test("runs a WebRTC-shaped provider through the provider-neutral core", async () => {
    const starts: VoiceAppContext[] = [];
    const contexts: VoiceAppContext[] = [];
    const transportMessages: unknown[] = [];
    let stops = 0;
    const provider: VoiceCallProvider = {
      getReadiness: () => ({ ready: true }),
      async start(input) {
        starts.push(input.context);
        input.emit({
          type: "event",
          event: { type: "notice", id: "provider-ready", text: "Provider ready" },
        });
        input.emit({ type: "transport", data: { type: "candidate", value: "server-data" } });
        const call = createProviderCall({ onStop: () => (stops += 1) });
        return {
          ...call,
          async handleTransportMessage(data) {
            transportMessages.push(data);
          },
          async updateContext(context) {
            contexts.push(context);
          },
        };
      },
    };
    const { client, messages } = createClient(provider);
    await client.handle(startRequest());
    const callId = acceptedCallId(messages);

    await client.handle({
      type: "voice.call.transport.client",
      callId,
      data: { type: "candidate", value: "client-data" },
    });
    await client.handle({
      type: "voice.call.context.update.request",
      requestId: "context-1",
      callId,
      context: { workspaceId: "workspace-2", agentId: "agent-2" },
    });
    await client.handle({ type: "voice.call.stop.request", requestId: "stop-1", callId });

    expect(starts).toEqual([{ workspaceId: "workspace-1", agentId: null }]);
    expect(contexts).toEqual([{ workspaceId: "workspace-2", agentId: "agent-2" }]);
    expect(transportMessages).toEqual([{ type: "candidate", value: "client-data" }]);
    expect(stops).toBe(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "voice.call.event",
        payload: expect.objectContaining({
          event: expect.objectContaining({ id: "provider-ready" }),
        }),
      }),
    );
    expect(messages).toContainEqual({
      type: "voice.call.transport.server",
      payload: { callId, data: { type: "candidate", value: "server-data" } },
    });
  });

  test("reserves startup before awaiting the provider", async () => {
    const gate = deferred<void>();
    const start = vi.fn(async () => {
      await gate.promise;
      return createProviderCall();
    });
    const { client, messages } = createClient({ getReadiness: () => ({ ready: true }), start });

    const first = client.handle(startRequest("start-1"));
    await client.handle(startRequest("start-2"));
    gate.resolve();
    await first;

    expect(start).toHaveBeenCalledTimes(1);
    expect(messages).toContainEqual({
      type: "voice.call.start.response",
      payload: {
        requestId: "start-2",
        accepted: false,
        callId: null,
        error: "A voice call is already active.",
      },
    });
  });

  test("disposes a provider call that finishes starting after client close", async () => {
    const gate = deferred<void>();
    let sawAbort = false;
    let stops = 0;
    const provider: VoiceCallProvider = {
      getReadiness: () => ({ ready: true }),
      async start(input) {
        await gate.promise;
        sawAbort = input.signal.aborted;
        return createProviderCall({ onStop: () => (stops += 1) });
      },
    };
    const { client } = createClient(provider);

    const starting = client.handle(startRequest());
    const closing = client.disconnect();
    gate.resolve();
    await Promise.all([starting, closing]);

    expect(sawAbort).toBe(true);
    expect(stops).toBe(1);
  });

  test.each([
    [{ type: "closed" } as const, "ended", null],
    [{ type: "failed", error: "upstream expired" } as const, "failed", "upstream expired"],
  ])("ends the call when the provider signals %s", async (terminal, lifecycle, error) => {
    const providerTerminal = deferred<VoiceProviderTerminal>();
    const provider: VoiceCallProvider = {
      getReadiness: () => ({ ready: true }),
      async start() {
        return createProviderCall({ terminal: providerTerminal });
      },
    };
    const { client, messages } = createClient(provider);
    await client.handle(startRequest());
    const callId = acceptedCallId(messages);

    providerTerminal.resolve(terminal);
    await vi.waitFor(() => {
      expect(messages).toContainEqual({
        type: "voice.call.state",
        payload: { callId, lifecycle, input: "idle", error },
      });
    });

    await client.handle(startRequest("start-2"));
    expect(acceptedCallId(messages, "start-2")).toBeTruthy();
  });

  test("cleanup is idempotent across concurrent stop and close", async () => {
    let stops = 0;
    const provider: VoiceCallProvider = {
      getReadiness: () => ({ ready: true }),
      async start() {
        return createProviderCall({ onStop: () => (stops += 1) });
      },
    };
    const { client, messages } = createClient(provider);
    await client.handle(startRequest());
    const callId = acceptedCallId(messages);

    await Promise.all([
      client.handle({ type: "voice.call.stop.request", requestId: "stop-1", callId }),
      client.disconnect(),
      client.disconnect(),
    ]);

    expect(stops).toBe(1);
    await client.handle(startRequest("start-2"));
    expect(acceptedCallId(messages, "start-2")).toBeTruthy();
  });
});

describe("legacy voice mode tombstone", () => {
  test("rejects without starting a compatibility path", () => {
    const messages: SessionOutboundMessage[] = [];
    rejectLegacyVoiceMode({ requestId: "request-1", emit: (message) => messages.push(message) });
    expect(messages).toEqual([
      {
        type: "set_voice_mode_response",
        payload: {
          requestId: "request-1",
          enabled: false,
          agentId: null,
          accepted: false,
          error: "Update Paseo to use voice chat.",
        },
      },
    ]);
  });
});
