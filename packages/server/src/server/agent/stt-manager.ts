import { transcribeAudio, type TranscriptionResult } from "./stt-openai.js";
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

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Transcribe audio buffer to text
   */
  public async transcribe(
    audio: Buffer,
    format: string,
    metadata?: TranscriptionMetadata
  ): Promise<SessionTranscriptionResult> {
    const context = metadata?.label ? ` (${metadata.label})` : "";
    console.log(
      `[STT-Manager ${this.sessionId}] Transcribing ${audio.length} bytes of ${format} audio${context}`
    );

    let debugRecordingPath: string | null = null;
    try {
      debugRecordingPath = await maybePersistDebugAudio(audio, {
        sessionId: this.sessionId,
        agentId: metadata?.agentId,
        requestId: metadata?.requestId,
        label: metadata?.label,
        format,
      });
    } catch (error) {
      console.warn(
        `[STT-Manager ${this.sessionId}] Failed to persist debug audio:`,
        error
      );
    }

    const result = await transcribeAudio(audio, format);

    // Filter out low-confidence transcriptions (non-speech sounds)
    if (result.isLowConfidence) {
      console.log(
        `[STT-Manager ${this.sessionId}] Filtered low-confidence transcription (likely non-speech): "${result.text}" (avg logprob: ${result.avgLogprob?.toFixed(2)})`
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

    console.log(
      `[STT-Manager ${this.sessionId}] Transcription complete: "${result.text}"${
        result.avgLogprob !== undefined ? ` (avg logprob: ${result.avgLogprob.toFixed(2)})` : ""
      }`
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
