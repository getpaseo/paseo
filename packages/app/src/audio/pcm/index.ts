const floatToInt16 = (sample: number): number => {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
};

export const resampleToPcm16 = (
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Int16Array => {
  if (input.length === 0) {
    return new Int16Array(0);
  }
  if (inputRate === outputRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = floatToInt16(input[i]);
    }
    return out;
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const i0 = Math.floor(sourceIndex);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = sourceIndex - i0;
    const sample = input[i0] * (1 - frac) + input[i1] * frac;
    out[i] = floatToInt16(sample);
  }
  return out;
};

export function parsePcmSampleRate(mimeType: string): number | null {
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

/** Shared pause state for the native player: a paused clip keeps its remaining time. */
export interface PcmPauseGate {
  readonly paused: boolean;
  onChange(listener: (paused: boolean) => void): () => void;
}

export function createPcmPauseGate(): PcmPauseGate & { set(paused: boolean): void } {
  const listeners = new Set<(paused: boolean) => void>();
  let paused = false;
  return {
    get paused() {
      return paused;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      if (next === paused) return;
      paused = next;
      for (const listener of Array.from(listeners)) listener(paused);
    },
  };
}

/** Keep voice output on the native communication engine and its echo reference. */
export function playPcm16(
  bytes: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
  output: PcmOutput,
  pause?: PcmPauseGate,
): Promise<number> {
  if (signal.aborted) return Promise.reject(new Error("Playback stopped"));
  const pcm = resamplePcm16(bytes, parsePcmSampleRate(mimeType) ?? 24000, 16000);
  const duration = pcm.length / 2 / 16000;
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let remainingMs = duration * 1000;
    let startedAt = 0;
    let unsubscribe = () => {};
    const done = () => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    const startTimer = () => {
      startedAt = Date.now();
      timeout = setTimeout(() => {
        done();
        resolve(duration);
      }, remainingMs);
    };
    // The native player stops on pause; completion time has to stop with it.
    const onPauseChange = (paused: boolean) => {
      if (paused && timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
        remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
      } else if (!paused && timeout === undefined) {
        startTimer();
      }
    };
    const abort = () => {
      clearTimeout(timeout);
      done();
      output.stopPlayback();
      reject(new Error("Playback stopped"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (!pause?.paused) output.resumePlayback();
      output.playPCMData(pcm);
      if (pause) unsubscribe = pause.onChange(onPauseChange);
      if (!pause?.paused) startTimer();
    } catch (error) {
      done();
      reject(error);
    }
  });
}
