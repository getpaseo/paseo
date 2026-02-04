import { Buffer } from "buffer";

export type SpeechSegment = { audioData: string; isLast: boolean };

export type SpeechSegmenterConfig = {
  enableContinuousStreaming: boolean;
  volumeThreshold: number; // 0..1
  silenceDurationMs: number;
  speechConfirmationMs: number;
  detectionGracePeriodMs: number;
  minChunkDurationMs?: number;
  pcmSampleRate?: number;
  pcmChannels?: number;
  pcmBitsPerSample?: number;
};

export type SpeechSegmenterCallbacks = {
  onAudioSegment?: (segment: SpeechSegment) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onDetectingChange?: (isDetecting: boolean) => void;
  onSpeakingChange?: (isSpeaking: boolean) => void;
};

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // NOTE: This is performance-sensitive during continuous streaming.
  // Buffer-backed base64 is significantly faster than manual string building.
  try {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  } catch {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    // eslint-disable-next-line no-restricted-globals
    return btoa(binary);
  }
}

function concatenateUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export class SpeechSegmenter {
  private config: Required<Omit<SpeechSegmenterConfig, "minChunkDurationMs" | "pcmSampleRate" | "pcmChannels" | "pcmBitsPerSample">> &
    Required<Pick<SpeechSegmenterConfig, "minChunkDurationMs" | "pcmSampleRate" | "pcmChannels" | "pcmBitsPerSample">>;
  private callbacks: SpeechSegmenterCallbacks;

  private audioBuffer: Uint8Array[] = [];
  private bufferedBytes = 0;

  private speechDetectionStartMs: number | null = null;
  private detectionSilenceStartMs: number | null = null;
  private silenceStartMs: number | null = null;
  private isSpeaking = false;
  private isDetecting = false;
  private speechConfirmed = false;

  private pcmBytesPerMs: number;
  private minChunkBytes: number;

  constructor(config: SpeechSegmenterConfig, callbacks: SpeechSegmenterCallbacks = {}) {
    this.config = {
      ...config,
      minChunkDurationMs: config.minChunkDurationMs ?? 1000,
      pcmSampleRate: config.pcmSampleRate ?? 16000,
      pcmChannels: config.pcmChannels ?? 1,
      pcmBitsPerSample: config.pcmBitsPerSample ?? 16,
    };
    this.callbacks = callbacks;
    this.pcmBytesPerMs = 0;
    this.minChunkBytes = 0;
    this.recomputeDerived();
  }

  updateConfig(next: SpeechSegmenterConfig): void {
    this.config = {
      ...next,
      minChunkDurationMs: next.minChunkDurationMs ?? this.config.minChunkDurationMs,
      pcmSampleRate: next.pcmSampleRate ?? this.config.pcmSampleRate,
      pcmChannels: next.pcmChannels ?? this.config.pcmChannels,
      pcmBitsPerSample: next.pcmBitsPerSample ?? this.config.pcmBitsPerSample,
    };
    this.recomputeDerived();
  }

  setCallbacks(callbacks: SpeechSegmenterCallbacks): void {
    this.callbacks = callbacks;
  }

  getSpeechDetectionStartMs(): number | null {
    return this.speechDetectionStartMs;
  }

  getIsSpeaking(): boolean {
    return this.isSpeaking;
  }

  getIsDetecting(): boolean {
    return this.isDetecting;
  }

  reset(): void {
    this.audioBuffer = [];
    this.bufferedBytes = 0;
    this.speechDetectionStartMs = null;
    this.detectionSilenceStartMs = null;
    this.silenceStartMs = null;
    this.isSpeaking = false;
    this.isDetecting = false;
    this.speechConfirmed = false;
  }

  flush(isLast: boolean): void {
    if (this.audioBuffer.length === 0) {
      this.bufferedBytes = 0;
      return;
    }

    const combinedBinary = concatenateUint8Arrays(this.audioBuffer);
    const pcmBase64 = uint8ArrayToBase64(combinedBinary);
    this.callbacks.onAudioSegment?.({ audioData: pcmBase64, isLast });

    this.audioBuffer = [];
    this.bufferedBytes = 0;
  }

  /**
   * Called when the input stream emits a PCM16 chunk (Uint8Array of bytes).
   * In non-continuous mode, chunk buffering is gated by the VAD state.
   */
  pushPcmChunk(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }

    if (this.config.enableContinuousStreaming) {
      this.audioBuffer.push(chunk);
      this.bufferedBytes += chunk.length;
      if (this.bufferedBytes >= this.minChunkBytes) {
        this.flush(false);
      }
      return;
    }

    // Buffer if we're detecting or speaking. When speech is confirmed, we also
    // stream partial chunks to reduce latency.
    if (this.speechDetectionStartMs !== null || this.isSpeaking) {
      this.audioBuffer.push(chunk);
      this.bufferedBytes += chunk.length;

      if (this.speechConfirmed && this.bufferedBytes >= this.minChunkBytes) {
        this.flush(false);
      }
    }
  }

  /**
   * Called with a normalized volume level (0..1). Drives VAD transitions.
   */
  pushVolumeLevel(volume: number, nowMs: number): void {
    if (this.config.enableContinuousStreaming) {
      return;
    }

    const speechDetected = volume > this.config.volumeThreshold;

    if (speechDetected && !this.isSpeaking && !this.speechConfirmed) {
      // Initial detection phase.
      if (this.speechDetectionStartMs === null) {
        this.speechDetectionStartMs = nowMs;
        this.detectionSilenceStartMs = null;
        this.audioBuffer = [];
        this.bufferedBytes = 0;
        this.setDetecting(true);
        return;
      }

      // Volume is back above threshold - reset grace period.
      this.detectionSilenceStartMs = null;

      const speechDuration = nowMs - this.speechDetectionStartMs;
      if (speechDuration >= this.config.speechConfirmationMs) {
        this.speechConfirmed = true;
        this.silenceStartMs = null;
        this.setDetecting(false);
        this.setSpeaking(true);
        this.callbacks.onSpeechStart?.();
      }
      return;
    }

    if (speechDetected && this.isSpeaking && this.speechConfirmed) {
      // Continuing confirmed speech.
      this.silenceStartMs = null;
      return;
    }

    if (!speechDetected && !this.speechConfirmed && this.speechDetectionStartMs !== null) {
      // Volume dropped during detection phase - apply grace period.
      if (this.detectionSilenceStartMs === null) {
        this.detectionSilenceStartMs = nowMs;
        return;
      }

      const graceDuration = nowMs - this.detectionSilenceStartMs;
      if (graceDuration >= this.config.detectionGracePeriodMs) {
        // Cancel detection.
        this.speechDetectionStartMs = null;
        this.detectionSilenceStartMs = null;
        this.audioBuffer = [];
        this.bufferedBytes = 0;
        this.setDetecting(false);
      }
      return;
    }

    if (!speechDetected && this.isSpeaking && this.speechConfirmed) {
      // Potential speech END.
      if (this.silenceStartMs === null) {
        this.silenceStartMs = nowMs;
        return;
      }

      const silenceDuration = nowMs - this.silenceStartMs;
      if (silenceDuration >= this.config.silenceDurationMs) {
        // Speech END confirmed.
        this.speechConfirmed = false;
        this.speechDetectionStartMs = null;
        this.silenceStartMs = null;
        this.setSpeaking(false);
        this.callbacks.onSpeechEnd?.();
        if (this.audioBuffer.length === 0) {
          // Important: downstream expects an explicit segment boundary marker.
          this.callbacks.onAudioSegment?.({ audioData: "", isLast: true });
        } else {
          this.flush(true);
        }
      }
    }
  }

  stop(nowMs: number): void {
    void nowMs;
    if (this.config.enableContinuousStreaming) {
      this.flush(true);
    }
    // Ensure observers see state clear transitions.
    this.setDetecting(false);
    this.setSpeaking(false);
    this.reset();
  }

  private setDetecting(next: boolean): void {
    if (this.isDetecting === next) {
      return;
    }
    this.isDetecting = next;
    this.callbacks.onDetectingChange?.(next);
  }

  private setSpeaking(next: boolean): void {
    if (this.isSpeaking === next) {
      return;
    }
    this.isSpeaking = next;
    this.callbacks.onSpeakingChange?.(next);
  }

  private recomputeDerived(): void {
    this.pcmBytesPerMs =
      (this.config.pcmSampleRate *
        this.config.pcmChannels *
        (this.config.pcmBitsPerSample / 8)) /
      1000;
    this.minChunkBytes = Math.round(this.pcmBytesPerMs * this.config.minChunkDurationMs);
  }
}
