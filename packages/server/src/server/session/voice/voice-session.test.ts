import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { VoiceSession, type VoiceSessionHost } from "./voice-session.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  SpeechToTextProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
  TextToSpeechProvider,
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";
import type { VoiceSpeakHandler } from "../../voice-types.js";

const VOICE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

class FakeVoiceTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public readonly requiredSampleRate = 16000;

  async connect(): Promise<void> {}

  appendPcm16(_chunk: Buffer): void {}

  flush(): void {}
  reset(): void {}
  close(): void {}
}

class FakeVoiceSttSession extends EventEmitter implements StreamingTranscriptionSession {
  public readonly requiredSampleRate = 16000;
  public commitCount = 0;

  async connect(): Promise<void> {}

  appendPcm16(_pcm16le: Buffer): void {}

  commit(): void {
    this.commitCount += 1;
  }

  clear(): void {}
  close(): void {}

  emitCommitted(event: StreamingTranscriptionCommittedEvent): void {
    this.emit("committed", event);
  }

  emitTranscript(event: StreamingTranscriptionEvent): void {
    this.emit("transcript", event);
  }
}

interface FakeVoiceHost extends VoiceSessionHost {
  readonly emitted: SessionOutboundMessage[];
  readonly spokenInput: Array<{ agentId: string; text: string }>;
}

function createFakeHost(): FakeVoiceHost {
  const emitted: SessionOutboundMessage[] = [];
  const spokenInput: Array<{ agentId: string; text: string }> = [];
  return {
    emitted,
    spokenInput,
    emit: (msg) => {
      emitted.push(msg);
    },
    loadAgent: async (agentId) =>
      ({ id: agentId, config: { systemPrompt: undefined } }) as unknown as ManagedAgent,
    reloadAgentSession: async (agentId) => ({ id: agentId }) as unknown as ManagedAgent,
    sendSpokenInput: async (agentId, text) => {
      spokenInput.push({ agentId, text });
    },
    interruptAgentIfRunning: async () => {},
    hasActiveAgentRun: () => false,
  };
}

function createVoiceSession() {
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const stt: SpeechToTextProvider = {
    id: "local",
    createSession: vi.fn(() => sttSession),
  };
  const turnDetection: TurnDetectionProvider = {
    id: "local",
    createSession: vi.fn(() => detector),
  };
  const host = createFakeHost();
  const voiceSession = new VoiceSession({
    host,
    logger: pino({ level: "silent" }),
    sessionId: "voice-session-test",
    sttLanguage: "en",
    tts: null,
    stt,
    voice: { turnDetection },
  });
  return { voiceSession, detector, sttSession, host };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("VoiceSession streaming transcription", () => {
  test("surfaces a refused voice-mode agent interruption", async () => {
    const { voiceSession, host } = createVoiceSession();
    host.interruptAgentIfRunning = vi.fn(async () => {
      throw new Error("active run cancellation was not acknowledged");
    });

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

    await expect(voiceSession.handleAbort()).rejects.toThrow(
      "active run cancellation was not acknowledged",
    );
    expect(host.interruptAgentIfRunning).toHaveBeenCalledWith(VOICE_AGENT_ID);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "activity_log",
        payload: expect.objectContaining({
          type: "error",
          content: "Voice interruption failed: active run cancellation was not acknowledged",
          metadata: { voiceAbortFailed: true },
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("delivers the streaming final transcript to the agent exactly once", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "ship the streaming final",
      isFinal: true,
      language: "en",
      avgLogprob: -0.1,
      isLowConfidence: false,
    });
    await settle();

    expect(sttSession.commitCount).toBe(1);
    expect(host.spokenInput).toEqual([
      { agentId: VOICE_AGENT_ID, text: "ship the streaming final" },
    ]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "ship the streaming final",
          language: "en",
          avgLogprob: -0.1,
        }),
      }),
    );

    await voiceSession.cleanup();
  });

  test("emits an empty transcript on finalization timeout without submitting to the agent", async () => {
    vi.useFakeTimers();
    try {
      const { voiceSession, detector, sttSession, host } = createVoiceSession();

      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });

      await vi.advanceTimersByTimeAsync(10_000);
      await settle();

      expect(host.spokenInput).toEqual([]);
      expect(host.emitted).toContainEqual(
        expect.objectContaining({
          type: "transcription_result",
          payload: expect.objectContaining({ text: "" }),
        }),
      );

      await voiceSession.cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  test("filters a low-confidence streaming final without submitting to the agent", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();

    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    detector.emit("speech_started");
    await settle();
    detector.emit("speech_stopped");
    await settle();
    sttSession.emitCommitted({ segmentId: "segment-1", previousSegmentId: null });
    sttSession.emitTranscript({
      segmentId: "segment-1",
      transcript: "background noise",
      isFinal: true,
      avgLogprob: -2.5,
      isLowConfidence: true,
    });
    await settle();

    expect(host.spokenInput).toEqual([]);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "transcription_result",
        payload: expect.objectContaining({
          text: "",
          avgLogprob: -2.5,
          isLowConfidence: true,
        }),
      }),
    );

    await voiceSession.cleanup();
  });
});

class FakeVoiceTts implements TextToSpeechProvider {
  public readonly synthesized: string[] = [];
  public failWith: Error | null = null;

  async synthesizeSpeech(text: string): Promise<{ stream: Readable; format: string }> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.synthesized.push(text);
    return {
      stream: Readable.from([Buffer.from(text)]),
      format: "pcm;rate=24000",
    };
  }
}

function createSpeakingVoiceSession() {
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const stt: SpeechToTextProvider = {
    id: "local",
    createSession: vi.fn(() => sttSession),
  };
  const turnDetection: TurnDetectionProvider = {
    id: "local",
    createSession: vi.fn(() => detector),
  };
  const host = createFakeHost();
  const tts = new FakeVoiceTts();
  const speakHandlers = new Map<string, VoiceSpeakHandler>();
  const voiceSession = new VoiceSession({
    host,
    logger: pino({ level: "silent" }),
    sessionId: "voice-session-speak-test",
    sttLanguage: "en",
    tts,
    stt,
    voice: { turnDetection },
    voiceBridge: {
      registerVoiceSpeakHandler: (agentId, handler) => {
        speakHandlers.set(agentId, handler);
      },
      unregisterVoiceSpeakHandler: (agentId) => {
        speakHandlers.delete(agentId);
      },
    },
  });
  return { voiceSession, host, tts, speakHandlers };
}

function audioOutputs(host: { emitted: SessionOutboundMessage[] }) {
  return host.emitted.filter(
    (msg): msg is Extract<SessionOutboundMessage, { type: "audio_output" }> =>
      msg.type === "audio_output",
  );
}

function assistantEntries(host: { emitted: SessionOutboundMessage[] }) {
  return host.emitted.filter(
    (msg) => msg.type === "activity_log" && msg.payload.type === "assistant",
  );
}

describe("VoiceSession speak handler", () => {
  test("records the spoken text in the chat before audio and returns without awaiting playback", async () => {
    const { voiceSession, host, speakHandlers } = createSpeakingVoiceSession();
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const handler = speakHandlers.get(VOICE_AGENT_ID);
    expect(handler).toBeDefined();

    // Playback is never confirmed; a handler that awaited playback would hang here.
    await handler!({ text: "Checking the config now.", callerAgentId: VOICE_AGENT_ID });

    expect(assistantEntries(host)).toHaveLength(1);
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "activity_log",
        payload: expect.objectContaining({
          type: "assistant",
          content: "Checking the config now.",
        }),
      }),
    );

    await vi.waitFor(() => {
      expect(audioOutputs(host).length).toBeGreaterThan(0);
    });
    const assistantIndex = host.emitted.findIndex(
      (msg) => msg.type === "activity_log" && msg.payload.type === "assistant",
    );
    const audioIndex = host.emitted.findIndex((msg) => msg.type === "audio_output");
    expect(assistantIndex).toBeLessThan(audioIndex);

    await voiceSession.cleanup();
  });

  test("plays overlapping speak calls in order, starting the next only after playback confirms", async () => {
    const { voiceSession, host, tts, speakHandlers } = createSpeakingVoiceSession();
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const handler = speakHandlers.get(VOICE_AGENT_ID)!;

    await handler({ text: "First update.", callerAgentId: VOICE_AGENT_ID });
    await handler({ text: "Second update.", callerAgentId: VOICE_AGENT_ID });

    await vi.waitFor(() => {
      expect(tts.synthesized).toEqual(["First update."]);
      expect(audioOutputs(host)).toHaveLength(1);
    });
    expect(assistantEntries(host)).toHaveLength(2);

    voiceSession.handleAudioPlayed(audioOutputs(host)[0].payload.id);

    await vi.waitFor(() => {
      expect(tts.synthesized).toEqual(["First update.", "Second update."]);
      expect(audioOutputs(host)).toHaveLength(2);
    });

    voiceSession.handleAudioPlayed(audioOutputs(host)[1].payload.id);
    await voiceSession.cleanup();
  });

  test("drops queued speech after an abort but keeps the text record", async () => {
    const { voiceSession, host, tts, speakHandlers } = createSpeakingVoiceSession();
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const handler = speakHandlers.get(VOICE_AGENT_ID)!;

    await handler({ text: "First update.", callerAgentId: VOICE_AGENT_ID });
    await handler({ text: "Queued update.", callerAgentId: VOICE_AGENT_ID });
    await vi.waitFor(() => {
      expect(audioOutputs(host)).toHaveLength(1);
    });

    await voiceSession.handleAbort();
    await settle();

    expect(tts.synthesized).toEqual(["First update."]);
    expect(audioOutputs(host)).toHaveLength(1);
    expect(assistantEntries(host)).toHaveLength(2);

    await voiceSession.cleanup();
  });

  test("surfaces synthesis failure as an error entry while keeping the text record", async () => {
    const { voiceSession, host, tts, speakHandlers } = createSpeakingVoiceSession();
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const handler = speakHandlers.get(VOICE_AGENT_ID)!;
    tts.failWith = new Error("synthesis exploded");

    await handler({ text: "Doomed reply.", callerAgentId: VOICE_AGENT_ID });

    expect(assistantEntries(host)).toHaveLength(1);
    await vi.waitFor(() => {
      expect(host.emitted).toContainEqual(
        expect.objectContaining({
          type: "activity_log",
          payload: expect.objectContaining({
            type: "error",
            content: expect.stringContaining("Voice playback failed: synthesis exploded"),
          }),
        }),
      );
    });

    await voiceSession.cleanup();
  });
});
