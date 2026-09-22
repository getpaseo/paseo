import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import type { AudioEngine } from "@/voice/audio-engine-types";
import { createVoiceRuntime, type VoiceSessionAdapter } from "@/voice/voice-runtime";
import { REALTIME_VOICE_VAD_CONFIG } from "@/voice/realtime-voice-config";

function createAudioEngineMock(): AudioEngine {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    startCapture: vi.fn().mockResolvedValue(undefined),
    stopCapture: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn().mockReturnValue(true),
    isMuted: vi.fn().mockReturnValue(false),
    play: vi.fn().mockResolvedValue(0.1),
    stop: vi.fn(),
    clearQueue: vi.fn(),
    isPlaying: vi.fn().mockReturnValue(false),
  };
}

function createSessionAdapter(serverId = "server-1"): VoiceSessionAdapter {
  return {
    serverId,
    setVoiceMode: vi.fn().mockResolvedValue({}),
    setVoiceInputMuted: vi.fn(async (muted: boolean) => muted),
    sendVoiceAudioChunk: vi.fn().mockResolvedValue(undefined),
    audioPlayed: vi.fn().mockResolvedValue(undefined),
    abortRequest: vi.fn().mockResolvedValue(undefined),
    setAssistantAudioPlaying: vi.fn(),
  };
}

function createAudioPayload(args: {
  id: string;
  groupId: string;
  chunkIndex: number;
  isLastChunk: boolean;
  isVoiceMode?: boolean;
}) {
  return {
    id: args.id,
    groupId: args.groupId,
    chunkIndex: args.chunkIndex,
    isLastChunk: args.isLastChunk,
    isVoiceMode: args.isVoiceMode ?? true,
    format: "pcm",
    audio: Buffer.from(`chunk-${args.chunkIndex}`).toString("base64"),
  } as const;
}

function createServerInfo(): DaemonServerInfo {
  return {
    serverId: "server-1",
    hostname: "host",
    version: "1.0.0",
    capabilities: {
      voice: {
        dictation: { enabled: true, reason: "" },
        voice: { enabled: true, reason: "" },
      },
    },
  };
}

function createRuntime(options?: {
  engine?: AudioEngine;
  getServerInfo?: (serverId: string) => DaemonServerInfo | null;
}) {
  const engine = options?.engine ?? createAudioEngineMock();
  const runtime = createVoiceRuntime({
    engine,
    getServerInfo: options?.getServerInfo ?? (() => createServerInfo()),
    activateKeepAwake: vi.fn().mockResolvedValue(undefined),
    deactivateKeepAwake: vi.fn().mockResolvedValue(undefined),
  });

  return { runtime, engine };
}

describe("voice runtime", () => {
  function createCommandRuntime() {
    const adapter = createSessionAdapter();
    vi.mocked(adapter.setVoiceMode).mockResolvedValue({
      voiceCommandsEnabled: true,
      isMuted: false,
    });
    const { runtime, engine } = createRuntime({
      getServerInfo: () => ({
        ...createServerInfo(),
        features: { voiceVerbalMute: true },
      }),
    });
    runtime.registerSession(adapter);
    return { runtime, engine, adapter };
  }

  it("keeps audio capture alive for verbal unmute and confirms state changes once", async () => {
    const { runtime, engine, adapter } = createCommandRuntime();
    await runtime.startVoice("server-1", "agent-1");
    runtime.onInputMutedChanged("server-1", true);
    runtime.onInputMutedChanged("server-1", true);
    runtime.handleCapturePcm(new Uint8Array([1, 2]));
    runtime.onServerSpeechStateChanged("server-1", true);
    expect(adapter.sendVoiceAudioChunk).toHaveBeenCalledOnce();
    expect(engine.toggleMute).not.toHaveBeenCalled();
    expect(engine.stopCapture).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().isMuted).toBe(true);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(false);
    runtime.onInputMutedChanged("server-1", false);
    expect(runtime.getSnapshot().isMuted).toBe(false);
    expect(engine.play).toHaveBeenCalledTimes(2);
    await runtime.destroy();
  });

  it("synchronizes tap mute with the host and preserves it across reconnect", async () => {
    const { runtime, adapter } = createCommandRuntime();
    await runtime.startVoice("server-1", "agent-1");
    runtime.toggleMute();
    runtime.handleCapturePcm(new Uint8Array([1, 2]));
    expect(adapter.sendVoiceAudioChunk).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.setVoiceInputMuted).toHaveBeenCalledWith(true);
    expect(runtime.getSnapshot()).toMatchObject({ isMuted: true, isMuteSwitching: false });
    runtime.updateSessionConnection("server-1", false);
    runtime.updateSessionConnection("server-1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.setVoiceMode).toHaveBeenLastCalledWith(true, "agent-1", {
      voiceCommandsEnabled: true,
      isMuted: true,
    });
    expect(runtime.getSnapshot().isMuted).toBe(true);
    await runtime.destroy();
  });

  it("pauses upload and exposes recovery when mute acknowledgement is lost", async () => {
    const { runtime, adapter } = createCommandRuntime();
    await runtime.startVoice("server-1", "agent-1");
    vi.mocked(adapter.setVoiceInputMuted).mockRejectedValue(new Error("Connection lost"));
    runtime.toggleMute();
    await vi.advanceTimersByTimeAsync(0);
    runtime.handleCapturePcm(new Uint8Array([1, 2]));
    expect(adapter.sendVoiceAudioChunk).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({
      isMuteSwitching: false,
      muteError: "Microphone paused: Connection lost. Stop and restart voice to reconnect.",
    });
    await runtime.destroy();
  });

  it("shows recognition failure and stops uploads instead of leaving verbal unmute silently unavailable", async () => {
    const { runtime, adapter } = createCommandRuntime();
    await runtime.startVoice("server-1", "agent-1");
    runtime.onInputMutedChanged("server-1", true);
    runtime.onInputError(
      "server-1",
      "Speech recognition failed. Stop and restart voice to reconnect.",
    );
    runtime.handleCapturePcm(new Uint8Array([1, 2]));
    expect(adapter.sendVoiceAudioChunk).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().muteError).toBe(
      "Speech recognition failed. Stop and restart voice to reconnect.",
    );
    await runtime.destroy();
  });

  it("ignores mute state from another host or a stopped voice session", async () => {
    const { runtime, engine } = createCommandRuntime();
    await runtime.startVoice("server-1", "agent-1");
    runtime.onInputMutedChanged("server-2", true);
    expect(runtime.getSnapshot().isMuted).toBe(false);
    await runtime.stopVoice();
    runtime.onInputMutedChanged("server-1", true);
    expect(runtime.getSnapshot().isMuted).toBe(false);
    expect(engine.play).not.toHaveBeenCalled();
    await runtime.destroy();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts voice when adapter is ready", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");

    expect(engine.initialize).toHaveBeenCalled();
    expect(adapter.setVoiceMode).toHaveBeenCalledWith(true, "agent-1");
    expect(engine.startCapture).toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({
      phase: "listening",
      isVoiceMode: true,
      activeServerId: "server-1",
      activeAgentId: "agent-1",
    });
  });

  it("streams continuous PCM chunks and waits after receiving a transcript", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.handleCapturePcm(new Uint8Array(32000));
    expect(runtime.getSnapshot().phase).toBe("listening");

    expect(adapter.sendVoiceAudioChunk).toHaveBeenLastCalledWith(
      expect.any(String),
      "audio/pcm;rate=16000;bits=16",
    );

    runtime.onTranscriptionResult("server-1", "hello");
    expect(runtime.getSnapshot().phase).toBe("waiting");
  });

  it("moves from listening to playing on the first assistant audio", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine: _engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onAssistantAudioStarted("server-1");

    expect(runtime.getSnapshot().phase).toBe("playing");
    expect(adapter.setAssistantAudioPlaying).toHaveBeenCalledWith(true);
  });

  it("starts playback on the first chunk before isLastChunk arrives", async () => {
    const adapter = createSessionAdapter();
    let resolvePlay!: (duration: number) => void;
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolvePlay = resolve;
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );

    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot().phase).toBe("playing");
      expect(adapter.audioPlayed).not.toHaveBeenCalled();
    });

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    expect(engine.play).toHaveBeenCalledTimes(1);
    resolvePlay(0.1);

    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-0");
      expect(engine.play).toHaveBeenCalledTimes(2);
    });
  });

  it("acknowledges chunks only after they are consumed and finishes after the final chunk", async () => {
    const adapter = createSessionAdapter();
    const playResolvers: Array<(duration: number) => void> = [];
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          playResolvers.push(resolve);
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();
    playResolvers.length = 0;

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );
    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
    });
    expect(adapter.audioPlayed).not.toHaveBeenCalled();

    playResolvers.shift()!(0.1);
    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-0");
      expect(engine.play).toHaveBeenCalledTimes(2);
    });

    playResolvers.shift()!(0.1);
    await vi.waitFor(() => {
      expect(adapter.audioPlayed).toHaveBeenCalledWith("chunk-1");
      expect(runtime.getSnapshot().phase).toBe("waiting");
    });
  });

  it("leaves playback phase unchanged after assistant playback while the turn is still active", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    runtime.onAssistantAudioStarted("server-1");
    runtime.onAssistantAudioFinished("server-1");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    expect(engine.play).toHaveBeenCalled();
  });

  it("starts the thinking tone when an agent turn begins before playback", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    expect(engine.play).toHaveBeenCalled();
  });

  it("does not restart the thinking tone from local detection jitter while waiting", async () => {
    const adapter = createSessionAdapter();
    let resolvePlay!: (duration: number) => void;
    const engine = createAudioEngineMock();
    vi.mocked(engine.play).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolvePlay = resolve;
        }),
    );
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");

    expect(runtime.getSnapshot().phase).toBe("waiting");
    expect(engine.play).toHaveBeenCalledTimes(1);
    vi.mocked(engine.stop).mockClear();
    vi.mocked(engine.clearQueue).mockClear();

    runtime.handleCaptureVolume(REALTIME_VOICE_VAD_CONFIG.volumeThreshold + 0.05);
    runtime.handleCaptureVolume(0);

    expect(engine.stop).not.toHaveBeenCalled();
    expect(engine.clearQueue).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenCalledTimes(1);

    runtime.onServerSpeechStateChanged("server-1", true);

    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(engine.clearQueue).toHaveBeenCalledTimes(1);

    resolvePlay(0.1);
  });

  it("returns to listening after assistant playback once the turn is complete", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    runtime.onAssistantAudioStarted("server-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_completed");
    runtime.onAssistantAudioFinished("server-1");

    expect(runtime.getSnapshot().phase).toBe("listening");
    expect(engine.play).toHaveBeenCalled();
  });

  it("keeps local volume alone non-authoritative for playback interruption", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    runtime.onAssistantAudioStarted("server-1");
    vi.mocked(engine.stop).mockClear();
    vi.mocked(engine.clearQueue).mockClear();

    runtime.handleCaptureVolume(0.5);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(false);
    expect(adapter.abortRequest).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe("playing");
  });

  it("keeps the meter white state driven by server speech detection", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.handleCaptureVolume(0.7);

    expect(runtime.getTelemetrySnapshot()).toMatchObject({
      volume: expect.any(Number),
      isSpeaking: false,
    });

    runtime.onServerSpeechStateChanged("server-1", true);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(true);

    runtime.onServerSpeechStateChanged("server-1", false);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(false);
  });

  it("stops assistant playback immediately when server speech starts", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onAssistantAudioStarted("server-1");

    runtime.onServerSpeechStateChanged("server-1", true);

    expect(engine.stop).toHaveBeenCalled();
    expect(engine.clearQueue).toHaveBeenCalled();
    expect(adapter.setAssistantAudioPlaying).toHaveBeenCalledWith(false);
    expect(runtime.getTelemetrySnapshot().isSpeaking).toBe(true);
  });

  it("drops queued voice chunks that arrive after server speech interrupts playback", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    runtime.onTurnEvent("server-1", "agent-1", "turn_started");
    vi.mocked(engine.play).mockClear();

    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-0",
        groupId: "group-1",
        chunkIndex: 0,
        isLastChunk: false,
      }),
    );
    await vi.waitFor(() => {
      expect(engine.play).toHaveBeenCalledTimes(1);
    });

    runtime.onServerSpeechStateChanged("server-1", true);
    runtime.handleAudioOutput(
      "server-1",
      createAudioPayload({
        id: "chunk-1",
        groupId: "group-1",
        chunkIndex: 1,
        isLastChunk: true,
      }),
    );

    expect(engine.stop).toHaveBeenCalled();
    expect(engine.clearQueue).toHaveBeenCalled();
    expect(vi.mocked(adapter.audioPlayed).mock.calls.flat()).not.toContain("chunk-1");
  });

  it("authoritatively stops and suppresses later voice audio", async () => {
    const adapter = createSessionAdapter();
    const { runtime, engine } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    await runtime.stopVoice();

    expect(adapter.setVoiceMode).toHaveBeenLastCalledWith(false);
    expect(engine.stopCapture).toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe("disabled");
    expect(runtime.shouldPlayVoiceAudio("server-1")).toBe(false);
  });

  it("rolls daemon voice mode back when capture fails after enabling it", async () => {
    const adapter = createSessionAdapter();
    const engine = createAudioEngineMock();
    vi.mocked(engine.startCapture).mockRejectedValue(new Error("audio focus unavailable"));
    const { runtime } = createRuntime({ engine });
    runtime.registerSession(adapter);

    await expect(runtime.startVoice("server-1", "agent-1")).rejects.toThrow(
      "audio focus unavailable",
    );

    expect(adapter.setVoiceMode).toHaveBeenNthCalledWith(1, true, "agent-1");
    expect(adapter.setVoiceMode).toHaveBeenNthCalledWith(2, false);
    expect(runtime.getSnapshot().phase).toBe("disabled");
  });

  it("returns an explicit not-ready error when the adapter is missing", async () => {
    const { runtime } = createRuntime();
    await expect(runtime.startVoice("server-1", "agent-1")).rejects.toThrow(
      "Voice runtime is not ready for host server-1",
    );
  });

  it("resyncs voice mode after connection recovers", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);

    await runtime.startVoice("server-1", "agent-1");
    vi.mocked(adapter.setVoiceMode).mockClear();

    runtime.updateSessionConnection("server-1", false);
    runtime.updateSessionConnection("server-1", true);
    await Promise.resolve();

    expect(adapter.setVoiceMode).toHaveBeenCalledWith(true, "agent-1");
  });

  it("does not emit when the snapshot is unchanged", async () => {
    const adapter = createSessionAdapter();
    const { runtime } = createRuntime();
    runtime.registerSession(adapter);
    await runtime.startVoice("server-1", "agent-1");

    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);

    runtime.handleCaptureVolume(0);
    runtime.handleCaptureVolume(0);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
