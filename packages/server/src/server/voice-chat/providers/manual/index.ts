import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../../messages.js";
import { TTSManager } from "./synthesis.js";
import { STTManager } from "./transcription.js";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
} from "../../../speech/speech-provider.js";
import type { TurnDetectionProvider } from "../../../speech/turn-detection-provider.js";
import { maybePersistTtsDebugAudio } from "../../../agent/tts-debug.js";
import { isPaseoDictationDebugEnabled } from "../../../agent/recordings-debug.js";
import { createVoiceTurnController, type VoiceTurnController } from "./turn.js";
import type { VoiceSpeakHandler } from "./speak.js";
import type { ManagedAgent } from "../../../agent/agent-manager.js";
import type { LocalSpeechModelId } from "../../../speech/providers/local/models.js";
import { toResolver, type Resolvable } from "../../../speech/provider-resolver.js";
import type {
  SpeechReadinessSnapshot,
  SpeechReadinessState,
} from "../../../speech/speech-runtime.js";

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
 * The agent-facing operations the manual call needs from its owner.
 * ManualVoiceCall owns all voice/audio state; it reaches back through this narrow
 * seam only to deliver transcripts to the agent, drive TTS playback, and
 * abort/inspect the active agent run.
 */
export interface ManualVoiceCallHost {
  emit(msg: SessionOutboundMessage): void;
  loadAgent(agentId: string): Promise<ManagedAgent>;
  sendSpokenInput(agentId: string, text: string): Promise<void>;
  interruptAgentIfRunning(agentId: string): Promise<void>;
  hasActiveAgentRun(agentId: string | null): boolean;
}

export interface ManualVoiceCallOptions {
  host: ManualVoiceCallHost;
  logger: pino.Logger;
  sessionId: string;
  sttLanguage?: string;
  tts: Resolvable<TextToSpeechProvider | null>;
  stt: Resolvable<SpeechToTextProvider | null>;
  voice?: {
    turnDetection?: Resolvable<TurnDetectionProvider | null>;
  };
  voiceBridge?: {
    registerVoiceSpeakHandler?: (agentId: string, handler: VoiceSpeakHandler) => void;
    unregisterVoiceSpeakHandler?: (agentId: string) => void;
  };
  getSpeechReadiness?: () => SpeechReadinessSnapshot;
  onFatalError?: (error: Error) => void;
}

/**
 * Owns the voice half of a client session: speech-to-text/text-to-speech
 * managers, the barge-in audio-buffering state machine,
 * voice-turn detection, and the MCP voice bridge. The session delegates the
 * voice/abort message types here and otherwise knows nothing about
 * audio buffering or processing phases.
 */
export class ManualVoiceCall {
  private readonly host: ManualVoiceCallHost;
  private readonly sessionLogger: pino.Logger;
  private readonly sessionId: string;
  private readonly sttLanguage: string;

  private abortController: AbortController;
  private processingPhase: ProcessingPhase = "idle";

  private isVoiceMode = false;
  private speechInProgress = false;

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
  private readonly getSpeechReadiness?: () => SpeechReadinessSnapshot;
  private readonly onFatalError?: (error: Error) => void;

  private voiceModeAgentId: string | null = null;

  constructor(options: ManualVoiceCallOptions) {
    const { host, logger, sessionId, sttLanguage, tts, stt, voice, voiceBridge } = options;
    this.host = host;
    this.sessionLogger = logger;
    this.sessionId = sessionId;
    this.sttLanguage = sttLanguage ?? "en";
    this.abortController = new AbortController();

    this.resolveVoiceTurnDetection = toResolver(voice?.turnDetection ?? null);
    this.registerVoiceSpeakHandler = voiceBridge?.registerVoiceSpeakHandler;
    this.unregisterVoiceSpeakHandler = voiceBridge?.unregisterVoiceSpeakHandler;
    this.getSpeechReadiness = options.getSpeechReadiness;
    this.onFatalError = options.onFatalError;

    this.ttsManager = new TTSManager(this.sessionId, this.sessionLogger, tts);
    this.sttManager = new STTManager(this.sessionId, this.sessionLogger, stt, {
      language: sttLanguage,
    });
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

  private resolveVoiceFeatureUnavailableContext(): VoiceFeatureUnavailableContext | null {
    const readiness = this.getSpeechReadiness?.();
    if (!readiness) {
      return null;
    }

    const modeReadiness = readiness.realtimeVoice;
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

  async start(agentId: string): Promise<void> {
    if (this.isVoiceMode) return;
    const unavailable = this.resolveVoiceFeatureUnavailableContext();
    if (unavailable) throw new Error(unavailable.message);
    const normalizedAgentId = this.parseVoiceTargetAgentId(agentId, "manual voice call");
    this.voiceModeAgentId = await this.enableVoiceModeForAgent(normalizedAgentId);
    try {
      await this.startVoiceTurnController();
      this.isVoiceMode = true;
    } catch (error) {
      await this.disableVoiceModeForActiveAgent();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isVoiceMode && !this.voiceModeAgentId) return;
    await this.disableVoiceModeForActiveAgent();
    this.isVoiceMode = false;
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
    this.sessionLogger.info(
      { agentId, elapsedMs: Date.now() - startedAt },
      "enableVoiceModeForAgent.ensureAgentLoaded.done",
    );

    this.registerVoiceBridgeForAgent(agentId);

    return existing.id;
  }

  private async disableVoiceModeForActiveAgent(): Promise<void> {
    await this.stopVoiceTurnController();

    const agentId = this.voiceModeAgentId;
    if (!agentId) {
      return;
    }

    this.unregisterVoiceSpeakHandler?.(agentId);
    this.voiceModeAgentId = null;
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
          this.sessionLogger.debug("Voice VAD speech_started");
        },
        onPartialTranscript: async ({ segmentId, transcript }) => {
          this.sessionLogger.info(
            { segmentId, transcriptLength: transcript.trim().length },
            "voice_input_state emitting isSpeaking=true",
          );
          this.emit({
            type: "voice_input_state",
            payload: {
              isSpeaking: true,
            },
          });
          await this.handleVoiceSpeechStart();
        },
        onSpeechStopped: async () => {
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
          this.onFatalError?.(error);
        },
      },
    });

    this.sessionLogger.info("startVoiceTurnController connecting controller");
    await controller.start();
    this.voiceTurnController = controller;
    this.sessionLogger.info("startVoiceTurnController connected");
  }

  private async stopVoiceTurnController(): Promise<void> {
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

  private async handleTranscriptionResultPayload(
    result: VoiceTranscriptionResultPayload,
  ): Promise<void> {
    const transcriptText = result.text.trim();

    this.emit({
      type: "transcription_result",
      payload: {
        text: result.text,
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

    if (!transcriptText) {
      this.sessionLogger.debug("Empty transcription (false positive), not aborting");
      this.setPhase("idle");
      this.clearSpeechInProgress("empty transcription");
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
      const abortSignal = signal ?? this.abortController.signal;
      await this.ttsManager.generateAndWaitForPlayback(
        text,
        (msg) => this.emit(msg),
        abortSignal,
        true,
      );
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

  /**
   * Tear down all voice resources.
   */
  async cleanup(): Promise<void> {
    this.abortController.abort();
    this.clearBufferTimeout();
    this.pendingAudioSegments = [];
    this.audioBuffer = null;
    await this.stopVoiceTurnController();

    this.ttsManager.cleanup();
    this.sttManager.cleanup();
    await this.disableVoiceModeForActiveAgent();
    this.isVoiceMode = false;
  }
}
