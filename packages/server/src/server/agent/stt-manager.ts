import type pino from "pino";
import type { SpeechToTextProvider, TranscriptionResult } from "../speech/speech-provider.js";
import { maybePersistDebugAudio } from "./stt-debug.js";

interface TranscriptionMetadata {
  agentId?: string;
  requestId?: string;
  label?: string;
}

export interface SessionTranscriptionResult extends TranscriptionResult {
  debugRecordingPath?: string;
  byteLength: number;
  format: string;
}

/**
 * Per-session STT manager
 * Handles speech-to-text transcription
 */
export class STTManager {
  private readonly sessionId: string;
  private readonly logger: pino.Logger;
  private readonly stt: SpeechToTextProvider | null;

  constructor(sessionId: string, logger: pino.Logger, stt: SpeechToTextProvider | null) {
    this.sessionId = sessionId;
    this.logger = logger.child({ module: "agent", component: "stt-manager", sessionId });
    this.stt = stt;
  }

  /**
   * Transcribe audio buffer to text
   */
  public async transcribe(
    audio: Buffer,
    format: string,
    metadata?: TranscriptionMetadata
  ): Promise<SessionTranscriptionResult> {
    if (!this.stt) {
      throw new Error("STT not configured");
    }

    this.logger.debug(
      { bytes: audio.length, format, label: metadata?.label },
      "Transcribing audio"
    );

    let debugRecordingPath: string | null = null;
    try {
      debugRecordingPath = await maybePersistDebugAudio(
        audio,
        {
          sessionId: this.sessionId,
          agentId: metadata?.agentId,
          requestId: metadata?.requestId,
          label: metadata?.label,
          format,
        },
        this.logger
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to persist debug audio");
    }

    const result = await this.stt.transcribeAudio(audio, format);

    // Filter out low-confidence transcriptions (non-speech sounds)
    if (result.isLowConfidence) {
      this.logger.debug(
        { text: result.text, avgLogprob: result.avgLogprob },
        "Filtered low-confidence transcription (likely non-speech)"
      );

      // Return empty text to ignore this transcription
      return {
        ...result,
        text: "",
        byteLength: audio.length,
        format,
        debugRecordingPath: debugRecordingPath ?? undefined,
      };
    }

    this.logger.debug(
      { text: result.text, avgLogprob: result.avgLogprob },
      "Transcription complete"
    );

    return {
      ...result,
      debugRecordingPath: debugRecordingPath ?? undefined,
      byteLength: audio.length,
      format,
    };
  }

  /**
   * Cleanup (currently no-op, but provides extension point)
   */
  public cleanup(): void {
    // No cleanup needed for STT currently
  }
}
