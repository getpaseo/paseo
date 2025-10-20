import { MicVAD } from "@ricky0123/vad-web";

export interface RealtimeVADConfig {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
  onVADMisfire?: () => void;
  onModelLoading?: () => void;
  onModelLoaded?: () => void;
  onError?: (error: Error) => void;
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  redemptionFrames?: number;
  frameSamples?: number;
  preSpeechPadFrames?: number;
  minSpeechFrames?: number;
}

export interface RealtimeVAD {
  start(): Promise<void>;
  pause(): void;
  destroy(): void;
  isListening(): boolean;
}

/**
 * Create a realtime VAD (Voice Activity Detection) instance using @ricky0123/vad-web
 * Continuously listens for speech and invokes callbacks when speech is detected
 */
export function createRealtimeVAD(config: RealtimeVADConfig): RealtimeVAD {
  let vad: Awaited<ReturnType<typeof MicVAD.new>> | null = null;
  let isActive = false;

  async function start(): Promise<void> {
    // If VAD already exists and is paused, just resume it
    if (vad && !isActive) {
      vad.start();
      isActive = true;
      console.log("[RealtimeVAD] VAD resumed");
      return;
    }

    if (isActive) {
      throw new Error("VAD is already active");
    }

    // Create new VAD instance
    try {
      config.onModelLoading?.();

      vad = await MicVAD.new({
        onSpeechStart: () => {
          console.log("[RealtimeVAD] Speech start detected");
          config.onSpeechStart?.();
        },
        onSpeechEnd: (audio: Float32Array) => {
          console.log("[RealtimeVAD] Speech end detected", {
            samples: audio.length,
            durationSeconds: audio.length / 16000,
          });
          config.onSpeechEnd?.(audio);
        },
        onVADMisfire: () => {
          console.log("[RealtimeVAD] VAD misfire (false positive)");
          config.onVADMisfire?.();
        },
        positiveSpeechThreshold: config.positiveSpeechThreshold ?? 0.5,
        negativeSpeechThreshold: config.negativeSpeechThreshold ?? 0.35,
        redemptionMs: config.redemptionFrames ? config.redemptionFrames * 16 : 128,
        preSpeechPadMs: config.preSpeechPadFrames ? config.preSpeechPadFrames * 16 : 16,
        minSpeechMs: config.minSpeechFrames ? config.minSpeechFrames * 16 : 48,
      });

      isActive = true;
      config.onModelLoaded?.();
      console.log("[RealtimeVAD] VAD created and started successfully");
    } catch (error) {
      console.error("[RealtimeVAD] Failed to start VAD:", error);
      const err =
        error instanceof Error ? error : new Error(String(error));
      config.onError?.(err);
      throw err;
    }
  }

  function pause(): void {
    if (vad && isActive) {
      vad.pause();
      isActive = false;
      console.log("[RealtimeVAD] VAD paused");
    }
  }

  function destroy(): void {
    if (vad) {
      vad.destroy();
      vad = null;
      isActive = false;
      console.log("[RealtimeVAD] VAD destroyed");
    }
  }

  function isListening(): boolean {
    return isActive;
  }

  return {
    start,
    pause,
    destroy,
    isListening,
  };
}

/**
 * Convert Float32Array PCM audio to audio blob
 * VAD returns Float32Array at 16kHz sample rate
 */
export function float32ArrayToBlob(
  audio: Float32Array,
  sampleRate: number = 16000
): Blob {
  // Convert Float32Array to 16-bit PCM
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // Create WAV header
  const wavHeader = createWavHeader(pcm.length * 2, sampleRate);

  // Combine header and data
  const wavBytes = new Uint8Array(wavHeader.length + pcm.length * 2);
  wavBytes.set(wavHeader, 0);
  wavBytes.set(new Uint8Array(pcm.buffer), wavHeader.length);

  return new Blob([wavBytes], { type: "audio/wav" });
}

/**
 * Create WAV file header
 */
function createWavHeader(dataLength: number, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // "RIFF" chunk descriptor
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");

  // "fmt " sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // SubChunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1 = mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // "data" sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  return new Uint8Array(header);
}

/**
 * Write string to DataView
 */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
