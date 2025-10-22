import { transcribeAudio, type TranscriptionResult } from "./stt-openai.js";

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
    format: string
  ): Promise<TranscriptionResult> {
    console.log(
      `[STT-Manager ${this.sessionId}] Transcribing ${audio.length} bytes of ${format} audio`
    );

    const result = await transcribeAudio(audio, format);

    console.log(
      `[STT-Manager ${this.sessionId}] Transcription complete: "${result.text}"`
    );

    return result;
  }

  /**
   * Cleanup (currently no-op, but provides extension point)
   */
  public cleanup(): void {
    // No cleanup needed for STT currently
  }
}
