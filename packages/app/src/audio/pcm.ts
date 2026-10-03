function parsePcmSampleRate(mimeType: string): number | null {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) {
    return null;
  }
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function resamplePcm16(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) {
    return pcm;
  }

  const inputSamples = Math.floor(pcm.length / 2);
  const outputSamples = Math.floor((inputSamples * toRate) / fromRate);
  const out = new Uint8Array(outputSamples * 2);
  const ratio = fromRate / toRate;

  const readInt16 = (sampleIndex: number): number => {
    const i = sampleIndex * 2;
    if (i + 1 >= pcm.length) {
      return 0;
    }
    const lo = pcm[i];
    const hi = pcm[i + 1];
    let value = (hi << 8) | lo;
    if (value & 0x8000) {
      value = value - 0x10000;
    }
    return value;
  };

  const writeInt16 = (sampleIndex: number, value: number): void => {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(value)));
    const i = sampleIndex * 2;
    out[i] = clamped & 0xff;
    out[i + 1] = (clamped >> 8) & 0xff;
  };

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const s0 = readInt16(i0);
    const s1 = readInt16(Math.min(inputSamples - 1, i0 + 1));
    writeInt16(i, s0 + (s1 - s0) * frac);
  }

  return out;
}

interface PcmOutput {
  resumePlayback(): void;
  playPCMData(bytes: Uint8Array): void;
  stopPlayback(): void;
}

/** Keep voice output on the native communication engine and its echo reference. */
export function playPcm16(
  bytes: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
  output: PcmOutput,
): Promise<number> {
  if (signal.aborted) return Promise.reject(new Error("Playback stopped"));
  const pcm = resamplePcm16(bytes, parsePcmSampleRate(mimeType) ?? 24000, 16000);
  const duration = pcm.length / 2 / 16000;
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      clearTimeout(timeout);
      output.stopPlayback();
      reject(new Error("Playback stopped"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      output.resumePlayback();
      output.playPCMData(pcm);
      timeout = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve(duration);
      }, duration * 1000);
    } catch (error) {
      signal.removeEventListener("abort", abort);
      reject(error);
    }
  });
}

/** Wrap the voice protocol's mono PCM16 LE bytes for a file decoder. */
export function pcmToWav(bytes: Uint8Array, mimeType: string): Uint8Array<ArrayBuffer> {
  const sampleRate = Number(/(?:^|;)rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000);
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate > 192000 ||
    bytes.length % 2
  ) {
    throw new Error("Invalid PCM16 audio");
  }
  const wav = new Uint8Array(44 + bytes.length);
  const view = new DataView(wav.buffer);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + bytes.length, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, bytes.length, true);
  wav.set(bytes, 44);
  return wav;
}
