import { describe, expect, it, vi } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import { createVoiceRuntime, type VoiceSessionAdapter } from "@/voice-chat/runtime";
import type {
  VoiceClientTransport,
  VoiceClientTransportFactory,
  VoiceTransportMediaState,
} from "@/voice-chat/transport";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createServerInfo(voiceChat = true): DaemonServerInfo {
  return {
    serverId: "server-1",
    hostname: "host",
    version: "1.0.0",
    features: { voiceChat },
  };
}

function createAdapter(): VoiceSessionAdapter {
  return {
    serverId: "server-1",
    startCall: vi.fn().mockResolvedValue({
      callId: "call-1",
      transport: { kind: "webrtc", answerSdp: "answer-sdp" },
    }),
    stopCall: vi.fn().mockResolvedValue(undefined),
    updateCallContext: vi.fn().mockResolvedValue(undefined),
    sendTransportMessage: vi.fn(),
    setAssistantAudioPlaying: vi.fn(),
  };
}

function createWebRtcTransportProbe() {
  let publish: ((state: VoiceTransportMediaState) => void) | null = null;
  const transport: VoiceClientTransport = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    handleServerMessage: vi.fn(),
    updateCallState: vi.fn(),
    toggleMute: vi.fn(),
  };
  const factory: VoiceClientTransportFactory = {
    async prepare() {
      return {
        offer: { kind: "webrtc", offerSdp: "offer-sdp" },
        accepts: (answer) => answer.kind === "webrtc",
        async accept(input) {
          if (input.answer.kind !== "webrtc") throw new Error("Expected WebRTC answer");
          publish = input.publish;
          return transport;
        },
        async discard() {},
      };
    },
  };
  return {
    factory,
    transport,
    publishMedia(state: VoiceTransportMediaState) {
      if (!publish) throw new Error("Transport was not accepted");
      publish(state);
    },
  };
}

function setup(voiceChat = true) {
  const transportProbe = createWebRtcTransportProbe();
  const runtime = createVoiceRuntime({
    transports: [transportProbe.factory],
    getServerInfo: () => createServerInfo(voiceChat),
    activateKeepAwake: vi.fn().mockResolvedValue(undefined),
    deactivateKeepAwake: vi.fn().mockResolvedValue(undefined),
  });
  const adapter = createAdapter();
  runtime.registerSession(adapter);
  return { runtime, adapter, transportProbe };
}

describe("voice call runtime", () => {
  it("starts through a WebRTC-shaped client transport without transport logic in runtime", async () => {
    const { runtime, adapter, transportProbe } = setup();
    const context = { workspaceId: "workspace-1", agentId: "agent-1" };

    await runtime.startCall("server-1", context);

    expect(adapter.startCall).toHaveBeenCalledWith(context, [
      { kind: "webrtc", offerSdp: "offer-sdp" },
    ]);
    expect(transportProbe.transport.start).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "listening",
      isVoiceMode: true,
      activeServerId: "server-1",
      activeCallId: "call-1",
    });
  });

  it("derives mute, volume, and playback from transport-owned media state", async () => {
    const { runtime, transportProbe } = setup();
    await runtime.startCall("server-1", { workspaceId: null, agentId: null });

    transportProbe.publishMedia({ isMuted: true, volume: 0.4, output: "speaking" });

    expect(runtime.getSnapshot()).toMatchObject({ isMuted: true, phase: "playing" });
    expect(runtime.getTelemetrySnapshot().volume).toBe(0.4);
  });

  it("keeps provider events as the lightweight transcript", async () => {
    const { runtime } = setup();
    await runtime.startCall("server-1", { workspaceId: null, agentId: null });

    runtime.handleCallEvent("server-1", "call-1", {
      type: "transcript",
      id: "utterance-1",
      speaker: "user",
      text: "hello",
      final: false,
    });
    runtime.handleCallEvent("server-1", "call-1", {
      type: "transcript",
      id: "utterance-1",
      speaker: "user",
      text: "hello there",
      final: true,
    });

    expect(runtime.getSnapshot().events).toEqual([
      expect.objectContaining({ id: "utterance-1", text: "hello there", final: true }),
    ]);
  });

  it("stops transport and server call exactly once", async () => {
    const { runtime, adapter, transportProbe } = setup();
    await runtime.startCall("server-1", { workspaceId: null, agentId: null });

    await runtime.stopVoice();

    expect(adapter.stopCall).toHaveBeenCalledWith("call-1");
    expect(transportProbe.transport.stop).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("terminates locally on disconnect so reconnect starts clean", async () => {
    const { runtime, transportProbe } = setup();
    await runtime.startCall("server-1", { workspaceId: null, agentId: null });

    runtime.updateSessionConnection("server-1", false);
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe("disabled"));

    expect(transportProbe.transport.stop).toHaveBeenCalledOnce();
  });

  it("stops a server call that is accepted after local startup cancellation", async () => {
    const { runtime, adapter, transportProbe } = setup();
    const started = deferred<{
      callId: string;
      transport: { kind: "webrtc"; answerSdp: string };
    }>();
    vi.mocked(adapter.startCall).mockReturnValue(started.promise);

    const starting = runtime.startCall("server-1", { workspaceId: null, agentId: null });
    await vi.waitFor(() => expect(adapter.startCall).toHaveBeenCalledOnce());
    await runtime.stopVoice();
    started.resolve({
      callId: "late-call",
      transport: { kind: "webrtc", answerSdp: "answer-sdp" },
    });
    await starting;

    expect(adapter.stopCall).toHaveBeenCalledWith("late-call");
    expect(transportProbe.transport.start).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("does not let an older startup replace a newer call", async () => {
    const { runtime, adapter, transportProbe } = setup();
    const older = deferred<{
      callId: string;
      transport: { kind: "webrtc"; answerSdp: string };
    }>();
    vi.mocked(adapter.startCall)
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({
        callId: "newer-call",
        transport: { kind: "webrtc", answerSdp: "newer-answer" },
      });

    const olderStart = runtime.startCall("server-1", { workspaceId: null, agentId: null });
    await vi.waitFor(() => expect(adapter.startCall).toHaveBeenCalledOnce());
    await runtime.startCall("server-1", { workspaceId: null, agentId: null });
    older.resolve({
      callId: "older-call",
      transport: { kind: "webrtc", answerSdp: "older-answer" },
    });
    await olderStart;

    expect(runtime.getSnapshot()).toMatchObject({
      phase: "listening",
      activeCallId: "newer-call",
    });
    expect(adapter.stopCall).toHaveBeenCalledWith("older-call");
    expect(transportProbe.transport.start).toHaveBeenCalledOnce();
  });

  it("forwards provider state and transport messages to the selected transport", async () => {
    const { runtime, transportProbe } = setup();
    await runtime.startCall("server-1", { workspaceId: null, agentId: null });
    const state = {
      callId: "call-1",
      lifecycle: "active" as const,
      input: "speech_detected" as const,
      error: null,
    };
    const data = { type: "candidate", value: "server-data" };

    runtime.handleCallState("server-1", state);
    runtime.handleTransportMessage("server-1", "call-1", data);

    expect(transportProbe.transport.updateCallState).toHaveBeenCalledWith(state);
    expect(transportProbe.transport.handleServerMessage).toHaveBeenCalledWith(data);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(true);
  });

  it("keeps provider terminal failures in the lightweight transcript", async () => {
    const { runtime } = setup();
    await runtime.startCall("server-1", { workspaceId: null, agentId: null });

    runtime.handleCallState("server-1", {
      callId: "call-1",
      lifecycle: "failed",
      input: "idle",
      error: "Realtime authentication expired",
    });
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe("disabled"));

    expect(runtime.getSnapshot().events).toContainEqual({
      type: "error",
      id: "call-terminal-call-1",
      message: "Realtime authentication expired",
    });
  });

  it("keeps media failure visible while terminating the call", async () => {
    const { runtime, adapter } = setup();
    await runtime.startCall("server-1", { workspaceId: null, agentId: null });

    await runtime.reportError("Microphone disconnected");

    expect(adapter.stopCall).toHaveBeenCalledWith("call-1");
    expect(runtime.getSnapshot()).toMatchObject({ phase: "disabled" });
    expect(runtime.getSnapshot().events).toContainEqual({
      type: "error",
      id: "media-error-call-1",
      message: "Microphone disconnected",
    });
  });

  it("rejects hosts without the new capability", async () => {
    const { runtime, adapter } = setup(false);
    await expect(
      runtime.startCall("server-1", { workspaceId: null, agentId: null }),
    ).rejects.toThrow("Update the Paseo host");
    expect(adapter.startCall).not.toHaveBeenCalled();
  });
});
