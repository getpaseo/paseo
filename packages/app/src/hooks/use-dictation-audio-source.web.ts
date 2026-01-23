import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DictationAudioSource, DictationAudioSourceConfig } from "./use-dictation-audio-source.types";

const getAudioContextCtor = (): (typeof AudioContext) | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const ctor =
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return ctor ?? null;
};

const floatToInt16 = (sample: number): number => {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
};

const resampleToPcm16 = (input: Float32Array, inputRate: number, outputRate: number): Int16Array => {
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

const concatInt16 = (a: Int16Array, b: Int16Array): Int16Array => {
  if (a.length === 0) {
    return b;
  }
  if (b.length === 0) {
    return a;
  }
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const int16ToBase64 = (pcm: Int16Array): string => {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export function useDictationAudioSource(config: DictationAudioSourceConfig): DictationAudioSource {
  const [volume, setVolume] = useState(0);

  const onPcmSegmentRef = useRef(config.onPcmSegment);
  const onErrorRef = useRef(config.onError);

  useEffect(() => {
    onPcmSegmentRef.current = config.onPcmSegment;
    onErrorRef.current = config.onError;
  }, [config.onPcmSegment, config.onError]);

  const refs = useRef<{
    stream: MediaStream | null;
    context: AudioContext | null;
    source: MediaStreamAudioSourceNode | null;
    processor: ScriptProcessorNode | null;
    gain: GainNode | null;
    pending: Int16Array;
    started: boolean;
  }>({ stream: null, context: null, source: null, processor: null, gain: null, pending: new Int16Array(0), started: false });

  const start = useCallback(async () => {
    const missingNavigator =
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function";

    const secureContext =
      typeof window !== "undefined" && typeof window.isSecureContext === "boolean"
        ? window.isSecureContext
        : true;
    const currentOrigin =
      typeof window !== "undefined" && window.location ? window.location.origin : "unknown";

    if (missingNavigator) {
      throw new Error("Microphone capture is not supported in this environment");
    }
    if (!secureContext) {
      throw new Error(`Microphone access requires HTTPS or localhost. Current origin: ${currentOrigin}`);
    }

    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      throw new Error("AudioContext unavailable");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });

    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const gain = context.createGain();
    gain.gain.value = 0;

    const outputRate = 16000;
    const chunkSamples = outputRate; // ~1s

    refs.current.started = true;

    processor.onaudioprocess = (event) => {
      if (!refs.current.started) {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);

      let sumSquares = 0;
      for (let i = 0; i < input.length; i++) {
        const sample = input[i];
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
      const normalized = Math.min(1, Math.max(0, rms * 2));
      setVolume(normalized);

      const next = resampleToPcm16(input, context.sampleRate, outputRate);
      refs.current.pending = concatInt16(refs.current.pending, next);

      while (refs.current.pending.length >= chunkSamples) {
        const chunk = refs.current.pending.slice(0, chunkSamples);
        refs.current.pending = refs.current.pending.slice(chunkSamples);
        onPcmSegmentRef.current(int16ToBase64(chunk));
      }
    };

    source.connect(processor);
    processor.connect(gain);
    gain.connect(context.destination);

    refs.current = { stream, context, source, processor, gain, pending: new Int16Array(0), started: true };
  }, []);

  const stop = useCallback(async () => {
    refs.current.started = false;
    setVolume(0);

    const { processor, source, gain, context, stream, pending } = refs.current;

    if (processor) {
      try {
        processor.onaudioprocess = null;
      } catch {
        // no-op
      }
      try {
        processor.disconnect();
      } catch {
        // no-op
      }
    }
    if (source) {
      try {
        source.disconnect();
      } catch {
        // no-op
      }
    }
    if (gain) {
      try {
        gain.disconnect();
      } catch {
        // no-op
      }
    }
    if (stream) {
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // no-op
        }
      });
    }
    if (context) {
      try {
        await context.close();
      } catch {
        // no-op
      }
    }

    if (pending.length > 0) {
      onPcmSegmentRef.current(int16ToBase64(pending));
    }

    refs.current = { stream: null, context: null, source: null, processor: null, gain: null, pending: new Int16Array(0), started: false };
  }, []);

  useEffect(() => {
    return () => {
      void stop().catch((err) => {
        onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      });
    };
  }, [stop]);

  return useMemo(
    () => ({
      start: async () => {
        try {
          await start();
        } catch (err) {
          const normalized = err instanceof Error ? err : new Error(String(err));
          onErrorRef.current?.(normalized);
          throw normalized;
        }
      },
      stop,
      volume,
    }),
    [start, stop, volume]
  );
}

