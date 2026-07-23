import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { VoiceSession, type VoiceSessionHost } from "./voice-session.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { AgentSessionConfig } from "../../agent/agent-sdk-types.js";
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
  readonly reloadedConfigs: Array<Partial<AgentSessionConfig> | undefined>;
}

function createFakeHost(
  config: AgentSessionConfig = { provider: "claude", cwd: "/tmp" },
): FakeVoiceHost {
  const emitted: SessionOutboundMessage[] = [];
  const spokenInput: Array<{ agentId: string; text: string }> = [];
  const reloadedConfigs: Array<Partial<AgentSessionConfig> | undefined> = [];
  return {
    emitted,
    spokenInput,
    reloadedConfigs,
    emit: (msg) => {
      emitted.push(msg);
    },
    loadAgent: async (agentId) => ({ id: agentId, config }) as unknown as ManagedAgent,
    reloadAgentSession: async (agentId, overrides) => {
      reloadedConfigs.push(overrides);
      return { id: agentId } as unknown as ManagedAgent;
    },
    sendSpokenInput: async (agentId, text) => {
      spokenInput.push({ agentId, text });
    },
    interruptAgentIfRunning: async () => {},
    hasActiveAgentRun: () => false,
  };
}

function createVoiceSession(config?: AgentSessionConfig) {
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
  const host = createFakeHost(config);
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

test("Codex voice mode adds and restores its MCP policy in provider-specific config", async () => {
  const originalExtra = { codex: { model_provider: "custom" } };
  const { voiceSession, host } = createVoiceSession({
    provider: "codex",
    cwd: "/tmp",
    extra: originalExtra,
  });

  await voiceSession.handleSetVoiceMode(true, VOICE_AGENT_ID);

  expect(host.reloadedConfigs[0]).toMatchObject({
    extra: {
      codex: {
        model_provider: "custom",
        mcpServerPolicies: {
          paseo: {
            enabled_tools: ["speak"],
            default_tools_approval_mode: "prompt",
            tools: { speak: { approval_mode: "approve" } },
          },
        },
      },
    },
  });

  await voiceSession.handleSetVoiceMode(false, VOICE_AGENT_ID);

  expect(host.reloadedConfigs[1]).toEqual({
    systemPrompt: expect.any(String),
    extra: originalExtra,
  });
  await voiceSession.cleanup();
});

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
