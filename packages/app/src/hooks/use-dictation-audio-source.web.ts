import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTauri } from "@/utils/tauri";

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

const int16ToFloat32 = (input: Int16Array): Float32Array => {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[i]! / 32768;
  }
  return out;
};

type Pcm16Wav = {
  sampleRate: number;
  samples: Int16Array;
};

const parsePcm16Wav = (buffer: ArrayBuffer): Pcm16Wav | null => {
  if (buffer.byteLength < 44) {
    return null;
  }

  const view = new DataView(buffer);
  const readAscii = (offset: number, length: number): string => {
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += String.fromCharCode(view.getUint8(offset + i));
    }
    return out;
  };

  if (readAscii(0, 4) !== "RIFF" || readAscii(8, 4) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > buffer.byteLength) {
      break;
    }

    if (chunkId === "fmt " && chunkSize >= 16) {
      const audioFormat = view.getUint16(chunkDataOffset, true);
      channels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
      if (audioFormat !== 1) {
        return null;
      }
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!dataOffset || !dataSize || sampleRate <= 0 || bitsPerSample !== 16 || channels <= 0) {
    return null;
  }

  const sampleCount = Math.floor(dataSize / 2);
  const interleaved = new Int16Array(buffer, dataOffset, sampleCount);

  if (channels === 1) {
    return { sampleRate, samples: new Int16Array(interleaved) };
  }

  const frameCount = Math.floor(interleaved.length / channels);
  const mono = new Int16Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += interleaved[frame * channels + ch] ?? 0;
    }
    mono[frame] = Math.round(sum / channels);
  }
  return { sampleRate, samples: mono };
};

const int16ToBase64 = (pcm: Int16Array): string => {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

type RecorderRefs = {
  recorder: MediaRecorder | null;
  audioChunks: Blob[];
  stoppedPromise: Promise<Blob> | null;
  stoppedResolve: ((blob: Blob) => void) | null;
  stoppedReject: ((error: unknown) => void) | null;
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
    mode: "pcm" | "recorder";
    recorder: RecorderRefs;
  }>({
    stream: null,
    context: null,
    source: null,
    processor: null,
    gain: null,
    pending: new Int16Array(0),
    started: false,
    mode: "pcm",
    recorder: {
      recorder: null,
      audioChunks: [],
      stoppedPromise: null,
      stoppedResolve: null,
      stoppedReject: null,
    },
  });

  const decodeAudioData = useCallback(async (context: AudioContext, buffer: ArrayBuffer): Promise<AudioBuffer> => {
    const maybePromise = context.decodeAudioData(buffer);
    if (maybePromise && typeof (maybePromise as Promise<AudioBuffer>).then === "function") {
      return maybePromise as Promise<AudioBuffer>;
    }
    return await new Promise<AudioBuffer>((resolve, reject) => {
      context.decodeAudioData(buffer, resolve, reject);
    });
  }, []);

  const emitPcmSegments = useCallback((pcm: Int16Array) => {
    const outputRate = 16000;
    const chunkSamples = outputRate; // ~1s
    let pending = pcm;
    while (pending.length >= chunkSamples) {
      const chunk = pending.slice(0, chunkSamples);
      pending = pending.slice(chunkSamples);
      onPcmSegmentRef.current(int16ToBase64(chunk));
    }
    if (pending.length > 0) {
      onPcmSegmentRef.current(int16ToBase64(pending));
    }
  }, []);

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
    const isTauri = getTauri() !== null;

    if (missingNavigator) {
      throw new Error("Microphone capture is not supported in this environment");
    }
    console.log("[DictationAudio][Web] Microphone preflight", {
      secureContext,
      currentOrigin,
      isTauri,
      hasMediaDevices:
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === "function",
    });
    if (!secureContext && !isTauri) {
      throw new Error(`Microphone access requires HTTPS or localhost. Current origin: ${currentOrigin}`);
    }
    if (!secureContext && isTauri) {
      console.warn(
        "[DictationAudio][Web] Insecure context reported under Tauri; attempting getUserMedia anyway",
        { currentOrigin }
      );
    }

    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      throw new Error("AudioContext unavailable");
    }

    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });

    const stream = rawStream as MediaStream;

    const context = new AudioContextCtor();

    try {
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const gain = context.createGain();
      gain.gain.value = 0;

      const outputRate = 16000;
      const chunkSamples = outputRate; // ~1s

      refs.current.started = true;
      refs.current.mode = "pcm";

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

      refs.current = {
        ...refs.current,
        stream,
        context,
        source,
        processor,
        gain,
        pending: new Int16Array(0),
        started: true,
      };
      return;
    } catch {
      // Fall back to MediaRecorder for environments where MediaStreamAudioSourceNode
      // isn't available (e.g., Playwright tests with a stubbed getUserMedia).
    }

    const RecorderCtor = typeof window !== "undefined" ? (window as any).MediaRecorder : undefined;
    if (!RecorderCtor) {
      throw new Error("MediaRecorder unavailable");
    }

    const recorder = new RecorderCtor(stream, { mimeType: "audio/webm;codecs=opus" } as MediaRecorderOptions) as MediaRecorder;

    const recorderRefs: RecorderRefs = {
      recorder,
      audioChunks: [],
      stoppedPromise: null,
      stoppedResolve: null,
      stoppedReject: null,
    };

    recorder.ondataavailable = (event: any) => {
      const data: Blob | undefined = event?.data;
      if (data) {
        recorderRefs.audioChunks.push(data);
      }
    };
    recorder.onerror = (event: any) => {
      recorderRefs.stoppedReject?.(event);
    };
    recorder.addEventListener("stop", () => {
      try {
        const blob = recorderRefs.audioChunks.length > 0 ? new Blob(recorderRefs.audioChunks, { type: recorder.mimeType }) : new Blob([], { type: recorder.mimeType });
        recorderRefs.stoppedResolve?.(blob);
      } catch (err) {
        recorderRefs.stoppedReject?.(err);
      }
    });

    recorderRefs.stoppedPromise = new Promise<Blob>((resolve, reject) => {
      recorderRefs.stoppedResolve = resolve;
      recorderRefs.stoppedReject = reject;
    });

    try {
      recorder.start();
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    refs.current = {
      ...refs.current,
      stream,
      context,
      source: null,
      processor: null,
      gain: null,
      pending: new Int16Array(0),
      started: true,
      mode: "recorder",
      recorder: recorderRefs,
    };
  }, []);

  const stop = useCallback(async () => {
    refs.current.started = false;
    setVolume(0);

    const { processor, source, gain, context, stream, pending, mode, recorder } =
      refs.current;

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

    if (mode === "recorder" && recorder.recorder) {
      try {
        if (recorder.recorder.state === "recording") {
          recorder.recorder.stop();
        }
      } catch {
        // ignore stop errors; we still need to stop tracks
      }
    }

    if (mode === "recorder" && recorder.stoppedPromise) {
      try {
        const blob = await recorder.stoppedPromise;
        const arrayBuffer = await blob.arrayBuffer();
        if (arrayBuffer.byteLength > 0) {
          const parsedWav = parsePcm16Wav(arrayBuffer);
          if (parsedWav) {
            const floatPcm = int16ToFloat32(parsedWav.samples);
            const pcm16 = resampleToPcm16(floatPcm, parsedWav.sampleRate, 16000);
            emitPcmSegments(pcm16);
          } else if (context) {
            const decoded = await decodeAudioData(context, arrayBuffer);
            const floatPcm = decoded.getChannelData(0);
            const pcm16 = resampleToPcm16(floatPcm, decoded.sampleRate, 16000);
            emitPcmSegments(pcm16);
          }
        }
      } catch (err) {
        onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)));
      }
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

    refs.current = {
      stream: null,
      context: null,
      source: null,
      processor: null,
      gain: null,
      pending: new Int16Array(0),
      started: false,
      mode: "pcm",
      recorder: {
        recorder: null,
        audioChunks: [],
        stoppedPromise: null,
        stoppedResolve: null,
        stoppedReject: null,
      },
    };
  }, [decodeAudioData, emitPcmSegments]);

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
