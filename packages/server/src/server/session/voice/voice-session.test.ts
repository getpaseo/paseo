import { EventEmitter } from "node:events";
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
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";

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

function createVoiceSession(sttProviderId = "local") {
  const detector = new FakeVoiceTurnDetectionSession();
  const sttSession = new FakeVoiceSttSession();
  const stt: SpeechToTextProvider = {
    id: sttProviderId,
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
  test.each(["openai", "custom-cloud"])(
    "never enables verbal mute with %s STT",
    async (provider) => {
      const { voiceSession, host } = createVoiceSession(provider);
      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID, "start", {
        voiceCommandsEnabled: true,
      });
      expect(host.emitted).toContainEqual(
        expect.objectContaining({
          type: "set_voice_mode_response",
          payload: expect.objectContaining({
            accepted: true,
            voiceCommandsEnabled: false,
            isMuted: false,
          }),
        }),
      );
      await voiceSession.handleSetInputMuted({ muted: true, requestId: "mute" });
      expect(host.emitted).toContainEqual({
        type: "voice.input.set_muted.response",
        payload: {
          requestId: "mute",
          muted: false,
          error: "Verbal mute requires an active voice session with local speech recognition.",
        },
      });
      await voiceSession.cleanup();
    },
  );

  test("requires client opt-in and retains muted state on reconnect", async () => {
    const { voiceSession, host } = createVoiceSession();
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID, "old-client");
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "set_voice_mode_response",
        payload: expect.objectContaining({ voiceCommandsEnabled: false }),
      }),
    );
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID, "start", {
      voiceCommandsEnabled: true,
    });
    await voiceSession.handleSetInputMuted({ muted: true, requestId: "mute" });
    expect(host.emitted).toContainEqual({
      type: "voice.input.set_muted.response",
      payload: { requestId: "mute", muted: true, error: null },
    });
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID, "reconnect", {
      voiceCommandsEnabled: true,
      isMuted: true,
    });
    expect(host.emitted).toContainEqual(
      expect.objectContaining({
        type: "set_voice_mode_response",
        payload: expect.objectContaining({
          requestId: "reconnect",
          voiceCommandsEnabled: true,
          isMuted: true,
        }),
      }),
    );
    expect(host.spokenInput).toEqual([]);
    await voiceSession.cleanup();
  });

  test("verbal mute discards private speech and hears unmute without sending either command", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();
    host.interruptAgentIfRunning = vi.fn(async () => {});
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID, "start", {
      voiceCommandsEnabled: true,
    });
    let segment = 0;
    async function say(transcript: string) {
      const segmentId = `command-${++segment}`;
      detector.emit("speech_started");
      await settle();
      sttSession.emitTranscript({ segmentId, transcript, isFinal: false });
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId, previousSegmentId: null });
      sttSession.emitTranscript({ segmentId, transcript, isFinal: true });
      await settle();
      await settle();
    }

    await say("Mute microphone.");
    expect(host.emitted).toContainEqual({
      type: "voice_input_state",
      payload: { isSpeaking: false, isMuted: true },
    });
    host.emitted.length = 0;
    await say("private conversation");
    await say("please explain how to unmute microphone");
    expect(host.emitted).toEqual([]);
    expect(host.interruptAgentIfRunning).not.toHaveBeenCalled();
    expect(host.spokenInput).toEqual([]);

    await say("Unmute microphone!");
    expect(host.emitted).toContainEqual({
      type: "voice_input_state",
      payload: { isSpeaking: false, isMuted: false },
    });
    expect(host.spokenInput).toEqual([]);
    await say("continue working");
    expect(host.spokenInput).toEqual([{ agentId: VOICE_AGENT_ID, text: "continue working" }]);
    await voiceSession.cleanup();
  });

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
