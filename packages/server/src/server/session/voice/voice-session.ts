import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { TTSManager } from "../../agent/tts-manager.js";
import { STTManager } from "../../agent/stt-manager.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../../speech/speech-provider.js";
import type { TurnDetectionProvider } from "../../speech/turn-detection-provider.js";
import { maybePersistTtsDebugAudio } from "../../agent/tts-debug.js";
import { isPaseoDictationDebugEnabled } from "../../agent/recordings-debug.js";
import {
  DictationStreamManager,
  type DictationStreamOutboundMessage,
} from "../../dictation/dictation-stream-manager.js";
import { createVoiceTurnController, type VoiceTurnController } from "./voice-turn-controller.js";
import { buildVoiceModeSystemPrompt, stripVoiceModeSystemPrompt } from "../../voice-config.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "../../voice-types.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { AgentSessionConfig } from "../../agent/agent-sdk-types.js";
import type { LocalSpeechModelId } from "../../speech/providers/local/models.js";
import { toResolver, type Resolvable } from "../../speech/provider-resolver.js";
import type { SpeechReadinessSnapshot, SpeechReadinessState } from "../../speech/speech-runtime.js";

const PCM_SAMPLE_RATE = 16000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_MS = (PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8)) / 1000;
const MIN_STREAMING_SEGMENT_DURATION_MS = 1000;
const MIN_STREAMING_SEGMENT_BYTES = Math.round(
  PCM_BYTES_PER_MS * MIN_STREAMING_SEGMENT_DURATION_MS,
);
const AgentIdSchema = z.guid();

type ProcessingPhase = "idle" | "transcribing";

interface VoiceModeBaseConfig {
  systemPrompt?: string;
}

interface AudioBufferState {
  chunks: Buffer[];
  format: string;
  isPCM: boolean;
  totalPCMBytes: number;
}

interface VoiceTranscriptionResultPayload {
  text: string;
  requestId: string;
  language?: string;
  duration?: number;
  avgLogprob?: number;
  isLowConfidence?: boolean;
  byteLength?: number;
  format?: string;
  debugRecordingPath?: string;
}

interface VoiceFeatureUnavailableContext {
  reasonCode: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  message: string;
  retryable: boolean;
  missingModelIds: LocalSpeechModelId[];
}

interface VoiceFeatureUnavailableResponseMetadata {
  reasonCode?: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  retryable?: boolean;
  missingModelIds?: LocalSpeechModelId[];
}

class VoiceFeatureUnavailableError extends Error {
  readonly reasonCode: SpeechReadinessSnapshot["voiceFeature"]["reasonCode"];
  readonly retryable: boolean;
  readonly missingModelIds: LocalSpeechModelId[];

  constructor(context: VoiceFeatureUnavailableContext) {
    super(context.message);
    this.name = "VoiceFeatureUnavailableError";
    this.reasonCode = context.reasonCode;
    this.retryable = context.retryable;
    this.missingModelIds = [...context.missingModelIds];
  }
}

function convertPCMToWavBuffer(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + pcmBuffer.length);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
}

/**
 * The agent-facing operations VoiceSession needs from the session that owns it.
 * VoiceSession owns all voice/audio state; it reaches back through this narrow
 * seam only to deliver transcripts to the agent, drive TTS playback, and
 * abort/inspect the active agent run.
 */
export interface VoiceSessionHost {
  emit(msg: SessionOutboundMessage): void;
  loadAgent(agentId: string): Promise<ManagedAgent>;
  reloadAgentSession(
    agentId: string,
    overrides: Partial<AgentSessionConfig>,
  ): Promise<ManagedAgent>;
  sendSpokenInput(agentId: string, text: string): Promise<void>;
  interruptAgentIfRunning(agentId: string): Promise<void>;
  hasActiveAgentRun(agentId: string | null): boolean;
  /** Whether the client pauses speech on "hold" and waits for "resume" or "stop". */
  supportsPlaybackHold(): boolean;
}

export interface VoiceSessionOptions {
  host: VoiceSessionHost;
  logger: pino.Logger;
  sessionId: string;
  onIdle?: () => void;
  sttLanguage?: string;
  tts: Resolvable<TextToSpeechProvider | null>;
  stt: Resolvable<SpeechToTextProvider | null>;
  voice?: {
    turnDetection?: Resolvable<TurnDetectionProvider | null>;
  };
  voiceBridge?: {
    registerVoiceSpeakHandler?: (agentId: string, handler: VoiceSpeakHandler) => void;
    unregisterVoiceSpeakHandler?: (agentId: string) => void;
    registerVoiceCallerContext?: (agentId: string, context: VoiceCallerContext) => void;
    unregisterVoiceCallerContext?: (agentId: string) => void;
  };
  dictation?: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    sttLanguage?: string;
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
}

/**
 * Owns the voice half of a client session: speech-to-text/text-to-speech
 * managers, dictation streaming, the barge-in audio-buffering state machine,
 * voice-turn detection, and the MCP voice bridge. The session delegates the
 * voice/dictation/abort message types here and otherwise knows nothing about
 * audio buffering or processing phases.
 */
export class VoiceSession {
  private readonly host: VoiceSessionHost;
  private readonly sessionLogger: pino.Logger;
  private readonly sessionId: string;
  private readonly sttLanguage: string;

  private abortController: AbortController;
  private closed = false;
  private readonly onIdle: (() => void) | undefined;
  private processingPhase: ProcessingPhase = "idle";

  private isVoiceMode = false;
  private speechInProgress = false;
  private isDetectorSpeaking = false;
  /** Sound arrived while a reply was at stake; the transcript decides whether it stops. */
  private bargeInPending = false;
  private bargeInClipTimer: ReturnType<typeof setTimeout> | null = null;
  /** Replies sent to speech: playing (endedAt null) or ended within ECHO_TAIL_MS. */
  private spokenReplies: Array<{ text: string; endedAt: number | null }> = [];

  private readonly dictationStreamManager: DictationStreamManager;
  private readonly resolveVoiceTurnDetection: () => TurnDetectionProvider | null;
  private voiceTurnController: VoiceTurnController | null = null;
  private voiceInputChunkCount = 0;
  private voiceInputBytes = 0;
  private voiceInputWindowStartedAt = Date.now();

  // Audio buffering for interruption handling
  private pendingAudioSegments: Array<{ audio: Buffer; format: string }> = [];
  private bufferTimeout: ReturnType<typeof setTimeout> | null = null;
  private audioBuffer: AudioBufferState | null = null;

  // Optional TTS debug capture (persisted per utterance)
  private readonly ttsDebugStreams = new Map<string, { format: string; chunks: Buffer[] }>();

  private readonly ttsManager: TTSManager;
  private readonly sttManager: STTManager;

  private readonly registerVoiceSpeakHandler?: (
    agentId: string,
    handler: VoiceSpeakHandler,
  ) => void;
  private readonly unregisterVoiceSpeakHandler?: (agentId: string) => void;
  private readonly registerVoiceCallerContext?: (
    agentId: string,
    context: VoiceCallerContext,
  ) => void;
  private readonly unregisterVoiceCallerContext?: (agentId: string) => void;
  private readonly getSpeechReadiness?: () => SpeechReadinessSnapshot;

  private voiceModeAgentId: string | null = null;
  private voiceModeBaseConfig: VoiceModeBaseConfig | null = null;

  constructor(options: VoiceSessionOptions) {
    const { host, logger, sessionId, sttLanguage, tts, stt, voice, voiceBridge, dictation } =
      options;
    this.host = host;
    this.onIdle = options.onIdle;
    this.sessionLogger = logger;
    this.sessionId = sessionId;
    this.sttLanguage = sttLanguage ?? "en";
    this.abortController = new AbortController();

    this.resolveVoiceTurnDetection = toResolver(voice?.turnDetection ?? null);
    this.registerVoiceSpeakHandler = voiceBridge?.registerVoiceSpeakHandler;
    this.unregisterVoiceSpeakHandler = voiceBridge?.unregisterVoiceSpeakHandler;
    this.registerVoiceCallerContext = voiceBridge?.registerVoiceCallerContext;
    this.unregisterVoiceCallerContext = voiceBridge?.unregisterVoiceCallerContext;
    this.getSpeechReadiness = dictation?.getSpeechReadiness;

    this.ttsManager = new TTSManager(this.sessionId, this.sessionLogger, tts);
    this.sttManager = new STTManager(this.sessionId, this.sessionLogger, stt, {
      language: sttLanguage,
    });
    this.dictationStreamManager = new DictationStreamManager({
      logger: this.sessionLogger,
      sessionId: this.sessionId,
      emit: (msg) => this.handleDictationManagerMessage(msg),
      stt: dictation?.stt ?? null,
      language: dictation?.sttLanguage,
      finalTimeoutMs: dictation?.finalTimeoutMs,
      onIdle: this.onIdle,
    });
  }

  get hasDemand(): boolean {
    return (
      this.isVoiceMode ||
      this.dictationStreamManager.hasDemand ||
      this.processingPhase !== "idle" ||
      this.audioBuffer !== null ||
      this.pendingAudioSegments.length > 0
    );
  }

  isActiveForAgent(agentId: string): boolean {
    return this.isVoiceMode && this.voiceModeAgentId === agentId;
  }

  handleDictationChunk(params: {
    dictationId: string;
    seq: number;
    audioBase64: string;
    format: string;
  }): Promise<void> {
    return this.dictationStreamManager.handleChunk(params);
  }

  handleDictationFinish(dictationId: string, finalSeq: number): Promise<void> {
    return this.dictationStreamManager.handleFinish(dictationId, finalSeq);
  }

  handleDictationCancel(dictationId: string): void {
    this.dictationStreamManager.handleCancel(dictationId);
  }

  async handleDictationStreamStart(
    msg: Extract<SessionInboundMessage, { type: "dictation_stream_start" }>,
  ): Promise<void> {
    const unavailable = this.resolveVoiceFeatureUnavailableContext("dictation");
    if (unavailable) {
      this.emit({
        type: "dictation_stream_error",
        payload: {
          dictationId: msg.dictationId,
          error: unavailable.message,
          retryable: unavailable.retryable,
          reasonCode: unavailable.reasonCode,
          missingModelIds: unavailable.missingModelIds,
        },
      });
      return;
    }
    await this.dictationStreamManager.handleStart(msg.dictationId, msg.format);
  }

  private toVoiceFeatureUnavailableContext(
    state: SpeechReadinessState,
  ): VoiceFeatureUnavailableContext {
    return {
      reasonCode: state.reasonCode,
      message: state.message,
      retryable: state.retryable,
      missingModelIds: [...state.missingModelIds],
    };
  }

  private resolveModeReadinessState(
    readiness: SpeechReadinessSnapshot,
    mode: "voice_mode" | "dictation",
  ): SpeechReadinessState {
    if (mode === "voice_mode") {
      return readiness.realtimeVoice;
    }
    return readiness.dictation;
  }

  private getVoiceFeatureUnavailableResponseMetadata(
    error: unknown,
  ): VoiceFeatureUnavailableResponseMetadata {
    if (!(error instanceof VoiceFeatureUnavailableError)) {
      return {};
    }
    return {
      reasonCode: error.reasonCode,
      retryable: error.retryable,
      missingModelIds: error.missingModelIds,
    };
  }

  private resolveVoiceFeatureUnavailableContext(
    mode: "voice_mode" | "dictation",
  ): VoiceFeatureUnavailableContext | null {
    const readiness = this.getSpeechReadiness?.();
    if (!readiness) {
      return null;
    }

    const modeReadiness = this.resolveModeReadinessState(readiness, mode);
    if (!modeReadiness.enabled) {
      return this.toVoiceFeatureUnavailableContext(modeReadiness);
    }
    if (!readiness.voiceFeature.available) {
      return this.toVoiceFeatureUnavailableContext(readiness.voiceFeature);
    }
    if (!modeReadiness.available) {
      return this.toVoiceFeatureUnavailableContext(modeReadiness);
    }
    return null;
  }

  /**
   * Handle voice mode toggle
   */
  async handleSetVoiceMode(enabled: boolean, agentId?: string, requestId?: string): Promise<void> {
    const startedAt = Date.now();
    try {
      this.sessionLogger.info(
        { enabled, requestedAgentId: agentId ?? null, requestId: requestId ?? null },
        "set_voice_mode started",
      );
      if (enabled) {
        const unavailable = this.resolveVoiceFeatureUnavailableContext("voice_mode");
        if (unavailable) {
          throw new VoiceFeatureUnavailableError(unavailable);
        }

        const normalizedAgentId = this.parseVoiceTargetAgentId(agentId ?? "", "set_voice_mode");

        if (
          this.isVoiceMode &&
          this.voiceModeAgentId &&
          this.voiceModeAgentId !== normalizedAgentId
        ) {
          this.sessionLogger.info(
            {
              previousAgentId: this.voiceModeAgentId,
              nextAgentId: normalizedAgentId,
              elapsedMs: Date.now() - startedAt,
            },
            "set_voice_mode disabling previous active voice agent",
          );
          await this.disableVoiceModeForActiveAgent(true);
        }

        if (!this.isVoiceMode || this.voiceModeAgentId !== normalizedAgentId) {
          this.sessionLogger.info(
            { agentId: normalizedAgentId, elapsedMs: Date.now() - startedAt },
            "set_voice_mode enabling voice for agent",
          );
          const refreshedAgentId = await this.enableVoiceModeForAgent(normalizedAgentId);
          this.voiceModeAgentId = refreshedAgentId;
          if (this.closed) {
            await this.disableVoiceModeForActiveAgent(true);
            return;
          }
          this.sessionLogger.info(
            { agentId: refreshedAgentId, elapsedMs: Date.now() - startedAt },
            "set_voice_mode agent enable complete",
          );
        }

        this.sessionLogger.info(
          { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
          "set_voice_mode starting voice turn controller",
        );
        await this.startVoiceTurnController();
        this.sessionLogger.info(
          { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
          "set_voice_mode voice turn controller started",
        );
        this.isVoiceMode = !this.closed;
        this.sessionLogger.info(
          {
            agentId: this.voiceModeAgentId,
            elapsedMs: Date.now() - startedAt,
          },
          "Voice mode enabled for existing agent",
        );
        if (requestId) {
          this.emit({
            type: "set_voice_mode_response",
            payload: {
              requestId,
              enabled: true,
              agentId: this.voiceModeAgentId,
              accepted: true,
              error: null,
            },
          });
        }
        return;
      }

      this.sessionLogger.info(
        { agentId: this.voiceModeAgentId, elapsedMs: Date.now() - startedAt },
        "set_voice_mode disabling active voice mode",
      );
      await this.disableVoiceModeForActiveAgent(true);
      this.isVoiceMode = false;
      this.clearPendingBargeIn();
      this.sessionLogger.info({ elapsedMs: Date.now() - startedAt }, "Voice mode disabled");
      if (requestId) {
        this.emit({
          type: "set_voice_mode_response",
          payload: {
            requestId,
            enabled: false,
            agentId: null,
            accepted: true,
            error: null,
          },
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to set voice mode";
      const unavailable = this.getVoiceFeatureUnavailableResponseMetadata(error);
      this.sessionLogger.error(
        {
          err: error,
          enabled,
          requestedAgentId: agentId ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        "set_voice_mode failed",
      );
      if (requestId) {
        this.emit({
          type: "set_voice_mode_response",
          payload: {
            requestId,
            enabled: this.isVoiceMode,
            agentId: this.voiceModeAgentId,
            accepted: false,
            error: errorMessage,
            ...unavailable,
          },
        });
        return;
      }
      throw error;
    }
  }

  private parseVoiceTargetAgentId(rawId: string, source: string): string {
    const parsed = AgentIdSchema.safeParse(rawId.trim());
    if (!parsed.success) {
      throw new Error(`${source}: agentId must be a UUID`);
    }
    return parsed.data;
  }

  private async enableVoiceModeForAgent(agentId: string): Promise<string> {
    const startedAt = Date.now();
    this.sessionLogger.info({ agentId }, "enableVoiceModeForAgent.ensureAgentLoaded.start");
    const existing = await this.host.loadAgent(agentId);
    if (this.closed) throw new Error("Voice source is closed");
    this.sessionLogger.info(
      { agentId, elapsedMs: Date.now() - startedAt },
      "enableVoiceModeForAgent.ensureAgentLoaded.done",
    );

    this.registerVoiceBridgeForAgent(agentId);

    const baseConfig: VoiceModeBaseConfig = {
      systemPrompt: stripVoiceModeSystemPrompt(existing.config.systemPrompt),
    };
    this.voiceModeBaseConfig = baseConfig;
    const refreshOverrides: Partial<AgentSessionConfig> = {
      systemPrompt: buildVoiceModeSystemPrompt(baseConfig.systemPrompt, true),
    };

    try {
      this.sessionLogger.info(
        { agentId, elapsedMs: Date.now() - startedAt },
        "enableVoiceModeForAgent.reloadAgentSession.start",
      );
      const refreshed = await this.host.reloadAgentSession(agentId, refreshOverrides);
      this.sessionLogger.info(
        { agentId, refreshedAgentId: refreshed.id, elapsedMs: Date.now() - startedAt },
        "enableVoiceModeForAgent.reloadAgentSession.done",
      );
      return refreshed.id;
    } catch (error) {
      this.unregisterVoiceSpeakHandler?.(agentId);
      this.unregisterVoiceCallerContext?.(agentId);
      this.voiceModeBaseConfig = null;
      throw error;
    }
  }

  private async disableVoiceModeForActiveAgent(restoreAgentConfig: boolean): Promise<void> {
    await this.stopVoiceTurnController();

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.voiceModeBaseConfig = null;
      return;
    }

    if (restoreAgentConfig && this.voiceModeBaseConfig) {
      const baseConfig = this.voiceModeBaseConfig;
      try {
        await this.host.reloadAgentSession(agentId, {
          systemPrompt: buildVoiceModeSystemPrompt(baseConfig.systemPrompt, false),
        });
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, agentId },
          "Failed to restore agent config while disabling voice mode",
        );
      }
    }

    this.unregisterVoiceSpeakHandler?.(agentId);
    this.unregisterVoiceCallerContext?.(agentId);
    this.voiceModeBaseConfig = null;
    this.voiceModeAgentId = null;
  }

  private handleDictationManagerMessage(msg: DictationStreamOutboundMessage): void {
    this.emit(msg as unknown as SessionOutboundMessage);
  }

  private async startVoiceTurnController(): Promise<void> {
    if (this.voiceTurnController) {
      this.sessionLogger.info("startVoiceTurnController skipped: already running");
      return;
    }

    const turnDetection = this.resolveVoiceTurnDetection();
    if (!turnDetection) {
      throw new Error("Voice turn detection is not configured");
    }
    const stt = this.sttManager.getProvider();
    if (!stt) {
      throw new Error("Voice speech-to-text is not configured");
    }

    this.sessionLogger.info(
      { providerId: turnDetection.id },
      "startVoiceTurnController creating controller",
    );

    const controller = createVoiceTurnController({
      logger: this.sessionLogger.child({ component: "voice-turn-controller" }),
      turnDetection,
      stt,
      sttLanguage: this.sttLanguage,
      callbacks: {
        onSpeechStarted: async () => {
          // Voice STT providers return final transcripts only. Use the detector's
          // confirmed speech event so interruption does not wait for transcription.
          this.sessionLogger.debug("Voice VAD speech_started");
          this.isDetectorSpeaking = true;
          if (this.shouldDeferBargeIn()) {
            this.deferBargeIn();
            return;
          }
          this.emit({ type: "voice_input_state", payload: { isSpeaking: true } });
          await this.handleVoiceSpeechStart();
        },
        onPartialTranscript: async ({ segmentId, transcript }) => {
          this.sessionLogger.debug(
            { segmentId, transcriptLength: transcript.trim().length },
            "Voice partial transcript",
          );
        },
        onSpeechStopped: async () => {
          this.isDetectorSpeaking = false;
          this.clearBargeInClipTimer();
          if (this.bargeInPending) {
            // The client was never told about this sound; it hears of it only if it has words.
            this.setPhase("transcribing");
            return;
          }
          this.handleVoiceSpeechStopped();
          this.setPhase("transcribing");
          this.emit({
            type: "activity_log",
            payload: {
              id: uuidv4(),
              timestamp: new Date(),
              type: "system",
              content: "Transcribing audio...",
            },
          });
        },
        onFinalTranscript: async ({
          transcript,
          language,
          durationMs,
          avgLogprob,
          isLowConfidence,
        }) => {
          const requestId = uuidv4();
          const transcriptText = isLowConfidence ? "" : transcript.trim();
          if (isLowConfidence) {
            this.sessionLogger.debug(
              { text: transcript, avgLogprob },
              "Filtered low-confidence transcription (likely non-speech)",
            );
          }
          this.sessionLogger.info(
            {
              requestId,
              isVoiceMode: this.isVoiceMode,
              transcriptLength: transcriptText.length,
              transcript: transcriptText,
            },
            "Transcription result",
          );
          await this.handleTranscriptionResultPayload({
            text: transcriptText,
            requestId,
            ...(language ? { language } : {}),
            duration: durationMs,
            ...(avgLogprob !== undefined ? { avgLogprob } : {}),
            ...(isLowConfidence !== undefined ? { isLowConfidence } : {}),
          });
        },
        onError: (error) => {
          this.sessionLogger.error({ err: error }, "Voice turn controller failed");
          this.isDetectorSpeaking = false;
          this.clearPendingBargeIn();
          this.clearSpeechInProgress("turn controller error");
          this.setPhase("idle");
        },
      },
    });

    this.sessionLogger.info("startVoiceTurnController connecting controller");
    this.voiceTurnController = controller;
    await controller.start();
    if (this.closed) await controller.stop();
    this.sessionLogger.info("startVoiceTurnController connected");
  }

  private async stopVoiceTurnController(): Promise<void> {
    this.isDetectorSpeaking = false;
    this.clearPendingBargeIn();
    this.spokenReplies = [];
    this.clearSpeechInProgress("voice turn controller stopped");
    if (!this.voiceTurnController) {
      return;
    }

    const controller = this.voiceTurnController;
    this.voiceTurnController = null;
    await controller.stop();
  }

  private handleVoiceSpeechStopped(): void {
    this.sessionLogger.info("voice_input_state emitting isSpeaking=false");
    this.emit({
      type: "voice_input_state",
      payload: {
        isSpeaking: false,
      },
    });
  }

  private async ensureAudioBufferForFormat(
    chunkFormat: string,
    isPCMChunk: boolean,
  ): Promise<AudioBufferState> {
    if (!this.audioBuffer) {
      this.audioBuffer = {
        chunks: [],
        format: chunkFormat,
        isPCM: isPCMChunk,
        totalPCMBytes: 0,
      };
      return this.audioBuffer;
    }
    if (this.audioBuffer.isPCM !== isPCMChunk) {
      this.sessionLogger.debug(
        {
          oldFormat: this.audioBuffer.isPCM ? "pcm" : this.audioBuffer.format,
          newFormat: chunkFormat,
        },
        `Audio format changed mid-stream, flushing current buffer`,
      );
      const finalized = this.finalizeBufferedAudio();
      if (finalized) {
        await this.processCompletedAudio(finalized.audio, finalized.format);
      }
      this.audioBuffer = {
        chunks: [],
        format: chunkFormat,
        isPCM: isPCMChunk,
        totalPCMBytes: 0,
      };
      return this.audioBuffer;
    }
    if (!this.audioBuffer.isPCM) {
      this.audioBuffer.format = chunkFormat;
    }
    return this.audioBuffer;
  }

  private async forwardAudioChunkToVoiceTurn(
    msg: Extract<SessionInboundMessage, { type: "voice_audio_chunk" }>,
    chunkFormat: string,
  ): Promise<void> {
    if (!this.voiceTurnController) {
      throw new Error("Voice mode is enabled but the voice turn controller is not running");
    }
    const chunkBytes = Buffer.byteLength(msg.audio, "base64");
    this.voiceInputChunkCount += 1;
    this.voiceInputBytes += chunkBytes;
    const now = Date.now();
    if (this.voiceInputChunkCount % 50 === 0 || now - this.voiceInputWindowStartedAt >= 1000) {
      this.sessionLogger.info(
        {
          chunkCount: this.voiceInputChunkCount,
          audioBytes: this.voiceInputBytes,
          windowMs: now - this.voiceInputWindowStartedAt,
          format: chunkFormat,
        },
        "Voice input chunk summary",
      );
      this.voiceInputWindowStartedAt = now;
      this.voiceInputChunkCount = 0;
      this.voiceInputBytes = 0;
    }
    await this.voiceTurnController.appendClientChunk({
      audioBase64: msg.audio,
      format: chunkFormat,
    });
  }

  async handleAudioChunk(
    msg: Extract<SessionInboundMessage, { type: "voice_audio_chunk" }>,
  ): Promise<void> {
    if (!this.isVoiceMode) {
      this.sessionLogger.warn(
        "Received voice_audio_chunk while voice mode is disabled; transcript will be emitted but voice assistant turn is skipped",
      );
    }

    const chunkFormat = msg.format || "audio/wav";

    if (this.isVoiceMode) {
      await this.forwardAudioChunkToVoiceTurn(msg, chunkFormat);
      return;
    }

    const chunkBuffer = Buffer.from(msg.audio, "base64");
    const isPCMChunk = chunkFormat.toLowerCase().includes("pcm");

    const buffer = await this.ensureAudioBufferForFormat(chunkFormat, isPCMChunk);

    buffer.chunks.push(chunkBuffer);
    if (buffer.isPCM) {
      buffer.totalPCMBytes += chunkBuffer.length;
    }

    // In non-voice mode, use streaming threshold to process chunks
    const reachedStreamingThreshold =
      !this.isVoiceMode && buffer.isPCM && buffer.totalPCMBytes >= MIN_STREAMING_SEGMENT_BYTES;

    if (!msg.isLast && reachedStreamingThreshold) {
      return;
    }

    const bufferedState = this.audioBuffer;
    const finalized = this.finalizeBufferedAudio();
    if (!finalized) {
      return;
    }

    if (!msg.isLast && reachedStreamingThreshold) {
      this.sessionLogger.debug(
        {
          minDuration: MIN_STREAMING_SEGMENT_DURATION_MS,
          pcmBytes: bufferedState?.totalPCMBytes ?? 0,
        },
        `Minimum chunk duration reached (~${MIN_STREAMING_SEGMENT_DURATION_MS}ms, ${
          bufferedState?.totalPCMBytes ?? 0
        } PCM bytes) – triggering STT`,
      );
    } else {
      this.sessionLogger.debug(
        { audioBytes: finalized.audio.length, chunks: bufferedState?.chunks.length ?? 0 },
        `Complete audio segment (${finalized.audio.length} bytes, ${bufferedState?.chunks.length ?? 0} chunk(s))`,
      );
    }

    await this.processCompletedAudio(finalized.audio, finalized.format);
  }

  private finalizeBufferedAudio(): { audio: Buffer; format: string } | null {
    if (!this.audioBuffer) {
      return null;
    }

    const bufferState = this.audioBuffer;
    this.audioBuffer = null;

    if (bufferState.isPCM) {
      const pcmBuffer = Buffer.concat(bufferState.chunks);
      const wavBuffer = convertPCMToWavBuffer(
        pcmBuffer,
        PCM_SAMPLE_RATE,
        PCM_CHANNELS,
        PCM_BITS_PER_SAMPLE,
      );
      return {
        audio: wavBuffer,
        format: "audio/wav",
      };
    }

    return {
      audio: Buffer.concat(bufferState.chunks),
      format: bufferState.format,
    };
  }

  private async processCompletedAudio(audio: Buffer, format: string): Promise<void> {
    if (this.processingPhase === "transcribing") {
      this.sessionLogger.debug(
        { phase: this.processingPhase, segmentCount: this.pendingAudioSegments.length + 1 },
        `Buffering audio segment (phase: ${this.processingPhase})`,
      );
      this.pendingAudioSegments.push({
        audio,
        format,
      });
      this.setBufferTimeout();
      return;
    }

    if (this.pendingAudioSegments.length > 0) {
      this.pendingAudioSegments.push({
        audio,
        format,
      });
      this.sessionLogger.debug(
        { segmentCount: this.pendingAudioSegments.length },
        `Processing ${this.pendingAudioSegments.length} buffered segments together`,
      );

      const pendingSegments = [...this.pendingAudioSegments];
      this.pendingAudioSegments = [];
      this.clearBufferTimeout();

      const combinedAudio = Buffer.concat(pendingSegments.map((segment) => segment.audio));
      const combinedFormat = pendingSegments[pendingSegments.length - 1].format;

      await this.processAudio(combinedAudio, combinedFormat);
      return;
    }

    await this.processAudio(audio, format);
  }

  private async flushPendingAudioSegments(reason: string): Promise<void> {
    if (this.processingPhase === "transcribing" || this.pendingAudioSegments.length === 0) {
      return;
    }

    const pendingSegments = [...this.pendingAudioSegments];
    this.pendingAudioSegments = [];
    this.clearBufferTimeout();

    this.sessionLogger.debug(
      { reason, segmentCount: pendingSegments.length },
      `Flushing ${pendingSegments.length} buffered audio segment(s)`,
    );

    const combinedAudio = Buffer.concat(pendingSegments.map((segment) => segment.audio));
    const combinedFormat = pendingSegments[pendingSegments.length - 1].format;

    await this.processAudio(combinedAudio, combinedFormat);
  }

  /**
   * Process audio through STT and then LLM
   */
  private async processAudio(audio: Buffer, format: string): Promise<void> {
    this.setPhase("transcribing");

    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "system",
        content: "Transcribing audio...",
      },
    });

    try {
      const requestId = uuidv4();
      const result = await this.sttManager.transcribe(audio, format, {
        requestId,
        label: this.isVoiceMode ? "voice" : "buffered",
      });

      const transcriptText = result.text.trim();
      this.sessionLogger.info(
        {
          requestId,
          isVoiceMode: this.isVoiceMode,
          transcriptLength: transcriptText.length,
          transcript: transcriptText,
        },
        "Transcription result",
      );

      await this.handleTranscriptionResultPayload({
        text: result.text,
        language: result.language,
        duration: result.duration,
        requestId,
        avgLogprob: result.avgLogprob,
        isLowConfidence: result.isLowConfidence,
        byteLength: result.byteLength,
        format: result.format,
        debugRecordingPath: result.debugRecordingPath,
      });
    } catch (error) {
      this.setPhase("idle");
      this.clearSpeechInProgress("transcription error");
      await this.flushPendingAudioSegments("transcription error");
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Transcription error: ${getErrorMessage(error)}`,
        },
      });
      throw error;
    }
  }

  private emitTranscriptionResult(result: VoiceTranscriptionResultPayload, text: string): void {
    this.emit({
      type: "transcription_result",
      payload: {
        text,
        ...(result.language ? { language: result.language } : {}),
        ...(result.duration !== undefined ? { duration: result.duration } : {}),
        requestId: result.requestId,
        ...(result.avgLogprob !== undefined ? { avgLogprob: result.avgLogprob } : {}),
        ...(result.isLowConfidence !== undefined
          ? { isLowConfidence: result.isLowConfidence }
          : {}),
        ...(result.byteLength !== undefined ? { byteLength: result.byteLength } : {}),
        ...(result.format ? { format: result.format } : {}),
        ...(result.debugRecordingPath ? { debugRecordingPath: result.debugRecordingPath } : {}),
      },
    });
  }

  /**
   * Decide a deferred barge-in. Returns true when the sound was not the user's words, in
   * which case the reply continues and the client hears nothing about it.
   */
  private async settlePendingBargeIn(result: VoiceTranscriptionResultPayload): Promise<boolean> {
    // Speech-to-text turns noise and half-heard echo into fragments ("S-") and fillers
    // ("Mm-hmm."). On a speakerphone the reply's own audio comes back as its words
    // ("A bicycle began a day."), which is echo too.
    let noise: string | null = null;
    if (!hasSpokenWord(result.text)) {
      noise = "no words";
    } else if (this.isEchoOfSpokenReply(result.text)) {
      noise = "echo of the reply";
    }
    if (noise) {
      const hasAnotherSpeechSegment =
        this.isDetectorSpeaking || this.pendingAudioSegments.length > 0;
      if (!hasAnotherSpeechSegment) {
        this.bargeInPending = false;
        this.clearSpeechInProgress("sound during a reply was not speech");
      }
      this.sessionLogger.info({ reason: noise }, "Barge-in verdict: reply continues");
      this.setPhase("idle");
      await this.flushPendingAudioSegments("sound during a reply was not speech");
      return true;
    }

    // Sound that is still going belongs to the next clip, which gets its own verdict.
    if (!this.isDetectorSpeaking) {
      this.clearPendingBargeIn();
    }
    this.sessionLogger.info({ reason: "speech transcribed" }, "Barge-in verdict: reply stops");
    this.emitTranscriptionResult(result, result.text);
    this.emit({ type: "voice_input_state", payload: { isSpeaking: false, playback: "stop" } });
    await this.handleAbort();
    return false;
  }

  private async handleTranscriptionResultPayload(
    result: VoiceTranscriptionResultPayload,
  ): Promise<void> {
    if (this.bargeInPending) {
      if (await this.settlePendingBargeIn(result)) {
        return;
      }
    } else {
      this.emitTranscriptionResult(result, result.text);
    }
    const transcriptText = result.text.trim();

    if (!transcriptText) {
      this.sessionLogger.debug("Empty transcription (false positive), not aborting");
      this.setPhase("idle");
      if (!this.isDetectorSpeaking) {
        this.clearSpeechInProgress("empty transcription");
      }
      await this.flushPendingAudioSegments("empty transcription");
      return;
    }

    // Has content - abort any in-progress stream now
    this.createAbortController();

    if (result.debugRecordingPath) {
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "system",
          content: `Saved input audio: ${result.debugRecordingPath}`,
          metadata: {
            recordingPath: result.debugRecordingPath,
            ...(result.format ? { format: result.format } : {}),
            requestId: result.requestId,
          },
        },
      });
    }

    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "transcript",
        content: result.text,
        metadata: {
          ...(result.language ? { language: result.language } : {}),
          ...(result.duration !== undefined ? { duration: result.duration } : {}),
        },
      },
    });

    this.clearSpeechInProgress("transcription complete");
    this.setPhase("idle");
    if (!this.isVoiceMode) {
      this.sessionLogger.debug(
        { requestId: result.requestId },
        "Skipping voice agent processing because voice mode is disabled",
      );
      await this.flushPendingAudioSegments("voice mode disabled");
      return;
    }

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      this.sessionLogger.warn(
        { requestId: result.requestId },
        "Skipping voice agent processing because no agent is currently voice-enabled",
      );
      await this.flushPendingAudioSegments("no active voice agent");
      return;
    }

    await this.host.sendSpokenInput(agentId, result.text);
    await this.flushPendingAudioSegments("transcription complete");
  }

  private registerVoiceBridgeForAgent(agentId: string): void {
    this.registerVoiceSpeakHandler?.(agentId, async ({ text, signal }) => {
      this.sessionLogger.info(
        {
          agentId,
          textLength: text.length,
          preview: text.slice(0, 160),
        },
        "Voice speak tool call received by session handler",
      );
      const abortSignal = signal
        ? AbortSignal.any([signal, this.abortController.signal])
        : this.abortController.signal;
      const spokenReply = this.rememberSpokenReply(text);
      try {
        await this.ttsManager.generateAndWaitForPlayback(
          text,
          (msg) => this.emit(msg),
          abortSignal,
          true,
        );
      } finally {
        spokenReply.endedAt = Date.now();
      }
      this.sessionLogger.info(
        { agentId, textLength: text.length },
        "Voice speak tool call finished playback",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "assistant",
          content: text,
        },
      });
    });

    this.registerVoiceCallerContext?.(agentId, {
      childAgentDefaultLabels: {},
      allowCustomCwd: false,
      enableVoiceTools: true,
    });
  }

  /**
   * Handle abort request from client
   */
  async handleAbort(): Promise<void> {
    this.sessionLogger.info(
      { phase: this.processingPhase },
      `Abort request, phase: ${this.processingPhase}`,
    );

    this.abortController.abort();
    this.ttsManager.cancelPendingPlaybacks("abort request");

    // Voice abort should always interrupt active agent output immediately.
    if (this.isVoiceMode && this.voiceModeAgentId) {
      try {
        await this.host.interruptAgentIfRunning(this.voiceModeAgentId);
      } catch (error) {
        const message = `Voice interruption failed: ${getErrorMessage(error)}`;
        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: message,
            metadata: { voiceAbortFailed: true },
          },
        });
        throw error;
      }
    }

    if (this.processingPhase === "transcribing") {
      // Still in STT phase - we'll buffer the next audio
      this.sessionLogger.debug("Will buffer next audio (currently transcribing)");
      // Phase stays as 'transcribing', handleAudioChunk will handle buffering
      return;
    }

    // Reset phase to idle and clear pending non-voice buffers.
    this.setPhase("idle");
    this.pendingAudioSegments = [];
    this.clearBufferTimeout();
  }

  /**
   * Handle audio playback confirmation from client
   */
  handleAudioPlayed(id: string): void {
    this.ttsManager.confirmAudioPlayed(id);
  }

  private rememberSpokenReply(text: string): { text: string; endedAt: number | null } {
    const reply = { text, endedAt: null };
    this.spokenReplies = [...this.recentSpokenReplies(), reply].slice(-MAX_SPOKEN_REPLIES);
    return reply;
  }

  private recentSpokenReplies(): Array<{ text: string; endedAt: number | null }> {
    const now = Date.now();
    return this.spokenReplies.filter(
      (reply) => reply.endedAt === null || now - reply.endedAt <= ECHO_TAIL_MS,
    );
  }

  private isEchoOfSpokenReply(transcript: string): boolean {
    const replies = this.recentSpokenReplies();
    if (replies.length === 0) {
      return false;
    }
    const echo = isEchoOfReplyText(
      transcript,
      replies.map((reply) => reply.text),
    );
    if (echo) {
      this.sessionLogger.info(
        { transcriptLength: transcript.length },
        "Transcript matches the reply being spoken; treating it as echo",
      );
    }
    return echo;
  }

  /**
   * Whether detected sound should wait for its transcript before it interrupts anything.
   * Only clients that act on a later "stop" qualify; older ones stop on speech start.
   */
  private shouldDeferBargeIn(): boolean {
    if (!this.host.supportsPlaybackHold()) {
      return false;
    }
    return (
      this.bargeInPending ||
      this.ttsManager.hasPendingPlayback() ||
      this.host.hasActiveAgentRun(this.voiceModeAgentId)
    );
  }

  /**
   * Start a user turn without touching the reply or telling the client. Sound during a
   * reply is mostly noise or the reply's own echo off a loudspeaker, and pausing on it
   * breaks the reply up, so the reply keeps playing and the agent keeps running until a
   * transcript has the user's words.
   */
  private deferBargeIn(): void {
    this.speechInProgress = true;
    this.bargeInPending = true;
    this.sessionLogger.info("Voice sound during a reply – waiting for the transcript");
    this.dropBufferedInput();
    // A detector that stays on (steady echo, a hum) never ends the utterance, and the
    // user's words would wait with it. Cut the clip so the transcript can decide.
    this.clearBargeInClipTimer();
    this.bargeInClipTimer = setTimeout(() => {
      this.bargeInClipTimer = null;
      if (!this.bargeInPending || !this.isDetectorSpeaking) {
        return;
      }
      this.sessionLogger.info(
        { maxClipMs: BARGE_IN_MAX_CLIP_MS },
        "Sound during a reply has not stopped; transcribing it so far",
      );
      void this.voiceTurnController?.endUtterance();
    }, BARGE_IN_MAX_CLIP_MS);
  }

  private clearBargeInClipTimer(): void {
    if (this.bargeInClipTimer) {
      clearTimeout(this.bargeInClipTimer);
      this.bargeInClipTimer = null;
    }
  }

  private clearPendingBargeIn(): void {
    this.bargeInPending = false;
    this.clearBargeInClipTimer();
  }

  private dropBufferedInput(): void {
    if (this.pendingAudioSegments.length > 0) {
      this.sessionLogger.debug(
        { segmentCount: this.pendingAudioSegments.length },
        `Dropping ${this.pendingAudioSegments.length} buffered audio segment(s) due to voice speech`,
      );
      this.pendingAudioSegments = [];
    }

    if (this.audioBuffer) {
      this.sessionLogger.debug(
        { chunks: this.audioBuffer.chunks.length, pcmBytes: this.audioBuffer.totalPCMBytes },
        `Clearing partial audio buffer (${this.audioBuffer.chunks.length} chunk(s)${
          this.audioBuffer.isPCM ? `, ${this.audioBuffer.totalPCMBytes} PCM bytes` : ""
        })`,
      );
      this.audioBuffer = null;
    }

    this.clearBufferTimeout();
  }

  /**
   * Mark speech detection start and abort any active playback/agent run.
   */
  private async handleVoiceSpeechStart(): Promise<void> {
    if (this.speechInProgress) {
      return;
    }

    const chunkReceivedAt = Date.now();
    const phaseBeforeAbort = this.processingPhase;
    const hadActiveStream = this.host.hasActiveAgentRun(this.voiceModeAgentId);

    this.speechInProgress = true;
    this.sessionLogger.debug("Voice speech detected – aborting playback and active agent run");

    this.dropBufferedInput();

    this.abortController.abort();
    await this.handleAbort();

    const latencyMs = Date.now() - chunkReceivedAt;
    this.sessionLogger.debug(
      { latencyMs, phaseBeforeAbort, hadActiveStream },
      "[Telemetry] barge_in.llm_abort_latency",
    );
  }

  /**
   * Clear speech-in-progress flag once the user turn has completed
   */
  private clearSpeechInProgress(reason: string): void {
    if (!this.speechInProgress) {
      return;
    }

    this.speechInProgress = false;
    this.sessionLogger.debug({ reason }, `Speech turn complete (${reason}) – resuming TTS`);
  }

  /**
   * Create new AbortController, aborting the previous one
   */
  private createAbortController(): AbortController {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.ttsDebugStreams.clear();
    return this.abortController;
  }

  /**
   * Set the processing phase
   */
  private setPhase(phase: ProcessingPhase): void {
    this.processingPhase = phase;
    if (phase === "idle") this.onIdle?.();
    this.sessionLogger.debug({ phase }, `Phase: ${phase}`);
  }

  /**
   * Set timeout to process buffered audio segments
   */
  private setBufferTimeout(): void {
    this.clearBufferTimeout();

    this.bufferTimeout = setTimeout(async () => {
      this.sessionLogger.debug("Buffer timeout reached, processing pending segments");

      if (this.processingPhase === "transcribing") {
        this.sessionLogger.debug(
          { segmentCount: this.pendingAudioSegments.length },
          "Buffer timeout deferred because transcription is still in progress",
        );
        this.setBufferTimeout();
        return;
      }

      if (this.pendingAudioSegments.length > 0) {
        const segments = [...this.pendingAudioSegments];
        this.pendingAudioSegments = [];
        this.bufferTimeout = null;

        const combined = Buffer.concat(segments.map((s) => s.audio));
        await this.processAudio(combined, segments[0].format);
      }
    }, 10000); // 10 second timeout
  }

  /**
   * Clear buffer timeout
   */
  private clearBufferTimeout(): void {
    if (this.bufferTimeout) {
      clearTimeout(this.bufferTimeout);
      this.bufferTimeout = null;
    }
  }

  /**
   * Emit a message to the client. Captures TTS audio_output frames for optional
   * debug persistence before forwarding to the session emitter.
   */
  private emit(msg: SessionOutboundMessage): void {
    if (this.closed) return;
    if (
      msg.type === "audio_output" &&
      (process.env.TTS_DEBUG_AUDIO_DIR || isPaseoDictationDebugEnabled()) &&
      msg.payload.groupId &&
      typeof msg.payload.audio === "string"
    ) {
      const groupId = msg.payload.groupId;
      const existing =
        this.ttsDebugStreams.get(groupId) ??
        ({ format: msg.payload.format, chunks: [] } satisfies {
          format: string;
          chunks: Buffer[];
        });

      try {
        existing.chunks.push(Buffer.from(msg.payload.audio, "base64"));
        existing.format = msg.payload.format;
        this.ttsDebugStreams.set(groupId, existing);
      } catch {
        // ignore malformed base64
      }

      if (msg.payload.isLastChunk) {
        const final = this.ttsDebugStreams.get(groupId);
        this.ttsDebugStreams.delete(groupId);
        if (final && final.chunks.length > 0) {
          void (async () => {
            const recordingPath = await maybePersistTtsDebugAudio(
              Buffer.concat(final.chunks),
              { sessionId: this.sessionId, groupId, format: final.format },
              this.sessionLogger,
            );
            if (recordingPath) {
              this.host.emit({
                type: "activity_log",
                payload: {
                  id: uuidv4(),
                  timestamp: new Date(),
                  type: "system",
                  content: `Saved TTS audio: ${recordingPath}`,
                  metadata: { recordingPath, format: final.format, groupId },
                },
              });
            }
          })();
        }
      }
    }
    this.host.emit(msg);
  }

  /** Stop input synchronously, including a source disconnected during bootstrap. */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    this.clearBufferTimeout();
    this.clearBargeInClipTimer();
    this.pendingAudioSegments = [];
    this.audioBuffer = null;
    const failures: unknown[] = [];
    for (const cleanup of [
      () => this.ttsManager.cleanup(),
      () => this.sttManager.cleanup(),
      () => this.dictationStreamManager.cleanupAll(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Voice input cleanup failed");
  }

  /** Restore the agent only after the caller has drained its in-flight requests. */
  async cleanup(): Promise<void> {
    try {
      this.cancel();
    } finally {
      try {
        await this.stopVoiceTurnController();
      } finally {
        await this.disableVoiceModeForActiveAgent(true);
        this.isVoiceMode = false;
      }
    }
  }
}

/** Longest stretch of unbroken sound during a reply before it is transcribed as it stands. */
const BARGE_IN_MAX_CLIP_MS = 4000;
/** How long after a reply's playback ends its echo can still reach the microphone. */
const ECHO_TAIL_MS = 3000;
const MAX_SPOKEN_REPLIES = 4;
/** Share of a held transcript's words that must come from the reply for it to count as echo. */
const ECHO_WORD_SHARE = 0.7;
/** Words a user says to cut a reply off. One the reply did not say marks the user's own speech. */
const INTERRUPT_WORDS = new Set([
  "stop",
  "wait",
  "pause",
  "hold",
  "cancel",
  "enough",
  "quiet",
  "hey",
  "no",
  "nope",
  "actually",
  "sorry",
]);

function wordTokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((token) =>
    token.replace(/'/g, ""),
  );
}

/**
 * True when a transcript is the reply's own audio picked up again: most of its words are
 * words of the reply, it has no interrupt word the reply did not say, and a transcript of
 * two or more words shares a word pair with the reply. Speech-to-text garbles echo
 * ("A bicycle began a day." for "The bicycle began in 1817"), so this matches words, not text.
 */
export function isEchoOfReplyText(transcript: string, replyTexts: readonly string[]): boolean {
  const words = wordTokens(transcript);
  if (words.length === 0) {
    return false;
  }
  const replyWords = replyTexts.flatMap(wordTokens);
  const replyWordSet = new Set(replyWords);
  if (words.some((word) => INTERRUPT_WORDS.has(word) && !replyWordSet.has(word))) {
    return false;
  }
  const shared = words.filter((word) => replyWordSet.has(word)).length;
  if (shared / words.length < ECHO_WORD_SHARE) {
    return false;
  }
  if (words.length === 1) {
    return true;
  }
  const replyPairs = new Set(replyWords.slice(1).map((word, i) => `${replyWords[i]} ${word}`));
  return words.slice(1).some((word, i) => replyPairs.has(`${words[i]} ${word}`));
}

const FILLER_WORDS = new Set([
  "ah",
  "eh",
  "er",
  "erm",
  "hm",
  "hmm",
  "huh",
  "mhm",
  "mm",
  "mmm",
  "uh",
  "uhm",
  "um",
  "umm",
]);

/**
 * True when a transcript holds at least one word: a Latin token of two or more letters
 * that is not a filler, or any token in another script (one Han character can be a word).
 * A token cut off with a trailing hyphen ("Sna-") is a fragment, not a word.
 */
export function hasSpokenWord(text: string): boolean {
  const withoutFragments = text.replace(/[\p{L}\p{N}']+-+(?=$|[\s\p{P}])/gu, " ");
  const tokens = withoutFragments.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  return tokens.some((token) => {
    const bare = token.replace(/'/g, "");
    if (/[^\p{Script=Latin}\p{N}]/u.test(bare)) return true;
    return bare.length >= 2 && !FILLER_WORDS.has(bare);
  });
}
