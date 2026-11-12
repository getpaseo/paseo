import { Readable } from "node:stream";
import type { VoiceSpeakHandler } from "../../voice-types.js";
import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import {
  VoiceSession,
  hasSpokenWord,
  isEchoOfReplyText,
  type VoiceSessionHost,
} from "./voice-session.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  StreamingTranscriptionCommittedEvent,
  StreamingTranscriptionEvent,
  StreamingTranscriptionSession,
} from "../../speech/speech-provider.js";
import type {
  TurnDetectionProvider,
  TurnDetectionSession,
} from "../../speech/turn-detection-provider.js";

const VOICE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
// The reply whose speakerphone echo came back as "A bicycle began a day." on an iPhone.
const BICYCLE_REPLY =
  "The bicycle began in 1817 with Karl Drais, a German inventor who built a two-wheeled, " +
  "steerable machine called the running machine, or draisine, which riders pushed along with their feet.";

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
    supportsPlaybackHold: () => false,
  };
}

function createVoiceSession(tts: TextToSpeechProvider | null = null) {
  let speakHandler: VoiceSpeakHandler | undefined;
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
    tts,
    voiceBridge: {
      registerVoiceSpeakHandler: (_id, handler) => {
        speakHandler = handler;
      },
    },
    stt,
    voice: { turnDetection },
  });
  return {
    voiceSession,
    detector,
    turnDetection,
    sttSession,
    host,
    speak: (args: Parameters<VoiceSpeakHandler>[0]) => {
      if (!speakHandler) throw new Error("Voice speak handler not registered");
      return speakHandler(args);
    },
  };
}

const FAKE_TTS: TextToSpeechProvider = {
  async synthesizeSpeech() {
    return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
  },
};

/** What the client is told about sound during a reply: speech state and transcripts. */
function bargeInMessages(host: FakeVoiceHost): SessionOutboundMessage[] {
  return host.emitted.filter(
    (message) => message.type === "voice_input_state" || message.type === "transcription_result",
  );
}

function isAudioOutput(message: SessionOutboundMessage): boolean {
  return message.type === "audio_output";
}

async function waitForAudioOutput(host: FakeVoiceHost): Promise<void> {
  await vi.waitFor(() => expect(host.emitted.filter(isAudioOutput)).toHaveLength(1));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("VoiceSession streaming transcription", () => {
  test("interrupts playback and the agent on speech detection without partial transcripts", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, detector, host, speak } = createVoiceSession(tts);
    const interrupted: string[] = [];
    async function recordInterruption(agentId: string) {
      interrupted.push(agentId);
    }
    host.interruptAgentIfRunning = recordInterruption;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({ text: "A spoken response." });
    try {
      await waitForAudioOutput(host);
      detector.emit("speech_started");
      await settle();
      expect(host.emitted).toContainEqual({
        type: "voice_input_state",
        payload: { isSpeaking: true },
      });
      expect(interrupted).toEqual([VOICE_AGENT_ID]);
      await playback;
    } finally {
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test.each(["", "S-", "Sna-", "Mm-hmm.", "uh, um", "..."])(
    "keeps a reply playing and tells the client nothing when the transcript is %j",
    async (transcript) => {
      const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
      const interrupted: string[] = [];
      host.interruptAgentIfRunning = async (agentId) => {
        interrupted.push(agentId);
      };
      host.supportsPlaybackHold = () => true;
      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      const playback = speak({ text: "A spoken response." });
      try {
        await waitForAudioOutput(host);
        detector.emit("speech_started");
        await settle();
        detector.emit("speech_stopped");
        await settle();
        sttSession.emitCommitted({ segmentId: "noise", previousSegmentId: null });
        sttSession.emitTranscript({ segmentId: "noise", transcript, isFinal: true });
        await settle();

        expect(bargeInMessages(host)).toEqual([]);
        expect(interrupted).toEqual([]);
        expect(host.spokenInput).toEqual([]);

        const audio = host.emitted.find(isAudioOutput);
        if (audio?.type !== "audio_output") throw new Error("no audio output");
        voiceSession.handleAudioPlayed(audio.payload.id);
        await playback;
      } finally {
        await voiceSession.cleanup();
        await playback.catch(() => {});
      }
    },
  );

  test("on a speakerphone, a transcript of the reply's own words leaves the reply playing", async () => {
    const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
    host.supportsPlaybackHold = () => true;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({ text: BICYCLE_REPLY });
    try {
      await waitForAudioOutput(host);
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "echo", previousSegmentId: null });
      sttSession.emitTranscript({
        segmentId: "echo",
        transcript: "A bicycle began a day.",
        isFinal: true,
      });
      await settle();

      expect(bargeInMessages(host)).toEqual([]);
      expect(host.spokenInput).toEqual([]);
    } finally {
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test.each([
    { transcript: "Is the baseball in season.", stops: false },
    { transcript: "No, the short version.", stops: true },
  ])(
    "right after a reply's audio starts, $transcript stops the reply: $stops",
    async ({ transcript, stops }) => {
      const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
      host.supportsPlaybackHold = () => true;
      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      const playback = speak({ text: "Here's the bicycle in six sentences." });
      try {
        await waitForAudioOutput(host);
        detector.emit("speech_started");
        await settle();
        detector.emit("speech_stopped");
        await settle();
        sttSession.emitCommitted({ segmentId: "leak", previousSegmentId: null });
        sttSession.emitTranscript({ segmentId: "leak", transcript, isFinal: true });
        await settle();

        expect(bargeInMessages(host).some((message) => message.type === "voice_input_state")).toBe(
          stops,
        );
      } finally {
        await voiceSession.cleanup();
        await playback.catch(() => {});
      }
    },
  );

  test.each([
    { transcript: "The English rounders?", stops: true },
    {
      transcript: "grew out of older bat-and-ball games like English rounders",
      stops: false,
    },
  ])(
    "well into a reply, its own words $transcript stop it: $stops",
    async ({ transcript, stops }) => {
      const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
      host.supportsPlaybackHold = () => true;
      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      const playback = speak({
        text: "Baseball grew out of older bat-and-ball games like English rounders.",
      });
      try {
        await waitForAudioOutput(host);
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(3500);
        detector.emit("speech_started");
        await vi.advanceTimersByTimeAsync(0);
        detector.emit("speech_stopped");
        await vi.advanceTimersByTimeAsync(0);
        sttSession.emitCommitted({ segmentId: "quote", previousSegmentId: null });
        sttSession.emitTranscript({ segmentId: "quote", transcript, isFinal: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(bargeInMessages(host).some((message) => message.type === "voice_input_state")).toBe(
          stops,
        );
      } finally {
        vi.useRealTimers();
        await voiceSession.cleanup();
        await playback.catch(() => {});
      }
    },
  );

  test.each([
    { transcript: "Hello", stops: false },
    { transcript: "Yeah.", stops: false },
    { transcript: "Yeah, okay, got it.", stops: false },
    { transcript: "Okay, I see.", stops: false },
    { transcript: "Okay, stop.", stops: true },
    { transcript: "Louder.", stops: true },
    { transcript: "Go on", stops: true },
  ])(
    "well into a reply, the lone transcript $transcript stops it: $stops",
    async ({ transcript, stops }) => {
      const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
      host.supportsPlaybackHold = () => true;
      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      const playback = speak({ text: "Here's the bicycle in six sentences." });
      try {
        await waitForAudioOutput(host);
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(3500);
        detector.emit("speech_started");
        await vi.advanceTimersByTimeAsync(0);
        detector.emit("speech_stopped");
        await vi.advanceTimersByTimeAsync(0);
        sttSession.emitCommitted({ segmentId: "one", previousSegmentId: null });
        sttSession.emitTranscript({ segmentId: "one", transcript, isFinal: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(bargeInMessages(host).some((message) => message.type === "voice_input_state")).toBe(
          stops,
        );
      } finally {
        vi.useRealTimers();
        await voiceSession.cleanup();
        await playback.catch(() => {});
      }
    },
  );

  test("once a reply's audio has played for a few seconds, unrelated words stop it", async () => {
    const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
    host.supportsPlaybackHold = () => true;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({ text: "Here's the bicycle in six sentences." });
    try {
      await waitForAudioOutput(host);
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(3500);
      detector.emit("speech_started");
      await vi.advanceTimersByTimeAsync(0);
      detector.emit("speech_stopped");
      await vi.advanceTimersByTimeAsync(0);
      sttSession.emitCommitted({ segmentId: "words", previousSegmentId: null });
      sttSession.emitTranscript({
        segmentId: "words",
        transcript: "Is the baseball in season.",
        isFinal: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(host.emitted).toContainEqual({
        type: "voice_input_state",
        payload: { isSpeaking: false, playback: "stop" },
      });
    } finally {
      vi.useRealTimers();
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test.each([
    { transcript: "stop", reply: "A spoken response." },
    { transcript: "wait, stop", reply: "A spoken response." },
    { transcript: "Wait, when did the bicycle begin?", reply: BICYCLE_REPLY },
  ])(
    "stops the reply only once the user's words $transcript are transcribed",
    async ({ transcript, reply }) => {
      const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
      const interrupted: string[] = [];
      host.interruptAgentIfRunning = async (agentId) => {
        interrupted.push(agentId);
      };
      host.supportsPlaybackHold = () => true;
      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      const playback = speak({ text: reply });
      try {
        await waitForAudioOutput(host);
        detector.emit("speech_started");
        await settle();
        detector.emit("speech_stopped");
        await settle();
        expect(bargeInMessages(host)).toEqual([]);
        expect(interrupted).toEqual([]);

        sttSession.emitCommitted({ segmentId: "words", previousSegmentId: null });
        sttSession.emitTranscript({ segmentId: "words", transcript, isFinal: true });
        await settle();

        expect(bargeInMessages(host)).toEqual([
          expect.objectContaining({
            type: "transcription_result",
            payload: expect.objectContaining({ text: transcript }),
          }),
          { type: "voice_input_state", payload: { isSpeaking: false, playback: "stop" } },
        ]);
        expect(interrupted).toEqual([VOICE_AGENT_ID]);
        expect(host.spokenInput).toEqual([{ agentId: VOICE_AGENT_ID, text: transcript }]);
        await playback;
      } finally {
        await voiceSession.cleanup();
        await playback.catch(() => {});
      }
    },
  );

  test("sound while the agent is still working does not interrupt it; the user's words do", async () => {
    const { voiceSession, detector, sttSession, host } = createVoiceSession();
    host.supportsPlaybackHold = () => true;
    host.hasActiveAgentRun = () => true;
    const interrupt = vi.fn(async () => {});
    host.interruptAgentIfRunning = interrupt;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    try {
      // The app's thinking tone, picked up by the microphone.
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "tone", previousSegmentId: null });
      sttSession.emitTranscript({ segmentId: "tone", transcript: "", isFinal: true });
      await settle();
      expect(bargeInMessages(host)).toEqual([]);
      expect(interrupt).not.toHaveBeenCalled();

      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      sttSession.emitCommitted({ segmentId: "words", previousSegmentId: "tone" });
      sttSession.emitTranscript({
        segmentId: "words",
        transcript: "Make it three sentences.",
        isFinal: true,
      });
      await settle();
      expect(host.emitted).toContainEqual({
        type: "voice_input_state",
        payload: { isSpeaking: false, playback: "stop" },
      });
      expect(interrupt).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(host.spokenInput).toEqual([
          { agentId: VOICE_AGENT_ID, text: "Make it three sentences." },
        ]),
      );
    } finally {
      await voiceSession.cleanup();
    }
  });

  test.each([
    { capable: true, confirmMs: 350 },
    { capable: false, confirmMs: undefined },
  ])(
    "asks the detector to report sound after $confirmMs ms when the client defers barge-in: $capable",
    async ({ capable, confirmMs }) => {
      const { voiceSession, turnDetection, host } = createVoiceSession();
      host.supportsPlaybackHold = () => capable;
      await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
      try {
        const [params] = vi.mocked(turnDetection.createSession).mock.calls[0];
        expect(params.confirmMs).toBe(confirmMs);
      } finally {
        await voiceSession.cleanup();
      }
    },
  );

  test("still defers the next sound after a transcription error", async () => {
    const { voiceSession, detector, host } = createVoiceSession();
    host.supportsPlaybackHold = () => true;
    host.hasActiveAgentRun = () => true;
    const interrupt = vi.fn(async () => {});
    host.interruptAgentIfRunning = interrupt;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    try {
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();
      detector.emit("error", new Error("transcription unavailable"));
      await settle();
      detector.emit("speech_started");
      await settle();
      expect(bargeInMessages(host)).toEqual([]);
      expect(interrupt).not.toHaveBeenCalled();
    } finally {
      await voiceSession.cleanup();
    }
  });

  test("repeated noise bursts leave the reply playing while their transcripts are pending", async () => {
    const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
    const interrupted: string[] = [];
    host.interruptAgentIfRunning = async (agentId) => {
      interrupted.push(agentId);
    };
    host.supportsPlaybackHold = () => true;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({ text: "A spoken response." });
    try {
      await waitForAudioOutput(host);
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();

      // Second noise burst arrives before the first final transcript settles.
      detector.emit("speech_started");
      await settle();
      detector.emit("speech_stopped");
      await settle();

      sttSession.emitCommitted({ segmentId: "noise-2", previousSegmentId: null });
      sttSession.emitTranscript({ segmentId: "noise-2", transcript: "", isFinal: true });
      await settle();

      expect(bargeInMessages(host)).toEqual([]);
      expect(interrupted).toEqual([]);

      const audio = host.emitted.find(isAudioOutput);
      if (audio?.type !== "audio_output") throw new Error("no audio output");
      voiceSession.handleAudioPlayed(audio.payload.id);
      await playback;
    } finally {
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
  });

  test("transcribes unbroken sound during a reply after four seconds without waiting for silence", async () => {
    const { voiceSession, detector, sttSession, host, speak } = createVoiceSession(FAKE_TTS);
    host.supportsPlaybackHold = () => true;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({ text: BICYCLE_REPLY });
    try {
      await waitForAudioOutput(host);
      vi.useFakeTimers();
      detector.emit("speech_started");
      await vi.advanceTimersByTimeAsync(3900);
      expect(sttSession.commitCount).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(sttSession.commitCount).toBe(1);

      // The sound carries on, so the detector reports it again as a new clip.
      detector.emit("speech_started");
      await vi.advanceTimersByTimeAsync(0);
      sttSession.emitCommitted({ segmentId: "long", previousSegmentId: null });
      sttSession.emitTranscript({
        segmentId: "long",
        transcript: "Stop. What year was that?",
        isFinal: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(host.emitted).toContainEqual({
        type: "voice_input_state",
        payload: { isSpeaking: false, playback: "stop" },
      });

      // The rest of the sound is decided on its own transcript, again without a word to the client.
      const toldSoFar = bargeInMessages(host).length;
      detector.emit("speech_stopped");
      await vi.advanceTimersByTimeAsync(0);
      sttSession.emitCommitted({ segmentId: "tail", previousSegmentId: "long" });
      sttSession.emitTranscript({ segmentId: "tail", transcript: "", isFinal: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(bargeInMessages(host)).toHaveLength(toldSoFar);
    } finally {
      vi.useRealTimers();
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
    expect(host.spokenInput.map((input) => input.text)).toEqual(["Stop. What year was that?"]);
  });

  test("session abort stops later audio even when the speak tool supplies its own signal", async () => {
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech() {
        return { stream: Readable.from([Buffer.from("audio")]), format: "pcm;rate=24000" };
      },
    };
    const { voiceSession, host, speak } = createVoiceSession(tts);
    const external = new AbortController();
    let abortRequested = false;
    const emit = host.emit;
    function acknowledgeLaterAudio(message: SessionOutboundMessage) {
      emit(message);
      if (message.type === "audio_output" && abortRequested)
        voiceSession.handleAudioPlayed(message.payload.id);
    }
    host.emit = acknowledgeLaterAudio;
    await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);
    const playback = speak({
      text: "First sentence. Second sentence. Third sentence.",
      signal: external.signal,
    });
    try {
      await waitForAudioOutput(host);
      abortRequested = true;
      await voiceSession.handleAbort();
      await playback;
      expect(host.emitted.filter(isAudioOutput)).toHaveLength(1);
      expect(external.signal.aborted).toBe(false);
    } finally {
      external.abort();
      await voiceSession.cleanup();
      await playback.catch(() => {});
    }
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

describe("isEchoOfReplyText", () => {
  test.each([
    "A bicycle began a day.",
    "The bicycle began in 1817 with Karl Drais.",
    "a German inventor",
    "Drais.",
  ])("counts %j as the reply's echo", (text) => {
    expect(isEchoOfReplyText(text, [BICYCLE_REPLY])).toBe(true);
  });

  test.each([
    "Stop.",
    "Wait, the bicycle began when?",
    "Wait, when did the bicycle begin?",
    "What year was that?",
    "Tell me about cars instead.",
    "",
  ])("counts %j as the user's speech", (text) => {
    expect(isEchoOfReplyText(text, [BICYCLE_REPLY])).toBe(false);
  });

  test("matches nothing without a reply", () => {
    expect(isEchoOfReplyText("A bicycle began a day.", [])).toBe(false);
  });
});

describe("hasSpokenWord", () => {
  test.each(["stop", "No.", "OK", "wait, stop", "well-known", "停", "l'eau"])(
    "counts %j as speech",
    (text) => {
      expect(hasSpokenWord(text)).toBe(true);
    },
  );

  test("counts a word in another script as noise when the language is Latin-script", () => {
    expect(hasSpokenWord("咳嗽", "en")).toBe(false);
    expect(hasSpokenWord("咳嗽", "en-US")).toBe(false);
    expect(hasSpokenWord("咳嗽", "zh")).toBe(true);
    expect(hasSpokenWord("stop 咳", "en")).toBe(true);
  });

  test.each(["", "S-", "Sna-", "Snarf-- uh", "Mm-hmm.", "uh, um", "...", "I"])(
    "counts %j as noise",
    (text) => {
      expect(hasSpokenWord(text)).toBe(false);
    },
  );
});
