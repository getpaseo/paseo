import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SpeechSegmenter } from "@/voice/speech-segmenter";
import { getTauri } from "@/utils/tauri";

export interface SpeechmaticsAudioConfig {
  onAudioSegment?: (segment: { audioData: string; isLast: boolean }) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
  /** When true, stream microphone PCM continuously without VAD gating. */
  enableContinuousStreaming?: boolean;
  volumeThreshold: number; // 0-1
  /** ms dip debounce before VAD transitions from confirmed speaking to non-speaking */
  confirmedDropGracePeriod?: number;
  silenceDuration: number; // ms of silence before ending segment
  speechConfirmationDuration: number; // ms of sustained speech before confirming
  detectionGracePeriod: number; // ms grace period for volume dips during detection
}

export interface SpeechmaticsAudio {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggleMute: () => void;
  isActive: boolean;
  isSpeaking: boolean;
  isDetecting: boolean;
  isMuted: boolean;
  volume: number;
  segmentDuration: number;
}

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

export function useSpeechmaticsAudio(config: SpeechmaticsAudioConfig): SpeechmaticsAudio {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [volume, setVolume] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [segmentDuration, setSegmentDuration] = useState(0);

  const enableContinuousStreaming = config.enableContinuousStreaming === true;

  const callbacksRef = useRef({
    onAudioSegment: config.onAudioSegment,
    onSpeechStart: config.onSpeechStart,
    onSpeechEnd: config.onSpeechEnd,
    onError: config.onError,
  });

  useEffect(() => {
    callbacksRef.current = {
      onAudioSegment: config.onAudioSegment,
      onSpeechStart: config.onSpeechStart,
      onSpeechEnd: config.onSpeechEnd,
      onError: config.onError,
    };
  }, [config.onAudioSegment, config.onSpeechStart, config.onSpeechEnd, config.onError]);

  const segmenterRef = useRef<SpeechSegmenter | null>(null);
  if (segmenterRef.current === null) {
    segmenterRef.current = new SpeechSegmenter(
      {
        enableContinuousStreaming,
        volumeThreshold: config.volumeThreshold,
        confirmedDropGracePeriodMs: config.confirmedDropGracePeriod,
        silenceDurationMs: config.silenceDuration,
        speechConfirmationMs: config.speechConfirmationDuration,
        detectionGracePeriodMs: config.detectionGracePeriod,
      },
      {
        onAudioSegment: (segment) => callbacksRef.current.onAudioSegment?.(segment),
        onSpeechStart: () => callbacksRef.current.onSpeechStart?.(),
        onSpeechEnd: () => callbacksRef.current.onSpeechEnd?.(),
        onDetectingChange: (next) => setIsDetecting(next),
        onSpeakingChange: (next) => setIsSpeaking(next),
      }
    );
  }

  useEffect(() => {
    segmenterRef.current?.updateConfig({
      enableContinuousStreaming,
      volumeThreshold: config.volumeThreshold,
      confirmedDropGracePeriodMs: config.confirmedDropGracePeriod,
      silenceDurationMs: config.silenceDuration,
      speechConfirmationMs: config.speechConfirmationDuration,
      detectionGracePeriodMs: config.detectionGracePeriod,
    });
  }, [
    enableContinuousStreaming,
    config.volumeThreshold,
    config.confirmedDropGracePeriod,
    config.silenceDuration,
    config.speechConfirmationDuration,
    config.detectionGracePeriod,
  ]);

  const refs = useRef<{
    started: boolean;
    stream: MediaStream | null;
    context: AudioContext | null;
    source: MediaStreamAudioSourceNode | null;
    processor: ScriptProcessorNode | null;
    gain: GainNode | null;
  }>({
    started: false,
    stream: null,
    context: null,
    source: null,
    processor: null,
    gain: null,
  });

  const isMutedRef = useRef(isMuted);
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  const vadConfigRef = useRef({
    volumeThreshold: config.volumeThreshold,
  });
  useEffect(() => {
    vadConfigRef.current = {
      volumeThreshold: config.volumeThreshold,
    };
  }, [config.volumeThreshold]);

  const vadLogRef = useRef({
    lastLogMs: 0,
    lastSpeaking: false,
    lastDetecting: false,
  });

  // Update segment duration timer
  useEffect(() => {
    if (!isDetecting && !isSpeaking) {
      setSegmentDuration(0);
      return;
    }

    const startTime = segmenterRef.current?.getSpeechDetectionStartMs() ?? Date.now();
    const interval = setInterval(() => {
      setSegmentDuration(Date.now() - startTime);
    }, 100);

    return () => clearInterval(interval);
  }, [isDetecting, isSpeaking]);

  const stopInternal = useCallback(async () => {
    refs.current.started = false;

    try {
      refs.current.processor?.disconnect();
      refs.current.source?.disconnect();
      refs.current.gain?.disconnect();
    } catch {
      // best-effort teardown
    }

    if (refs.current.stream) {
      for (const track of refs.current.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }

    const context = refs.current.context;
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }

    refs.current.stream = null;
    refs.current.context = null;
    refs.current.source = null;
    refs.current.processor = null;
    refs.current.gain = null;

    segmenterRef.current?.stop(Date.now());
    setIsActive(false);
    setIsSpeaking(false);
    setIsDetecting(false);
    setVolume(0);
    setIsMuted(false);
  }, []);

  const start = useCallback(async () => {
    if (refs.current.started) {
      return;
    }

    const missingNavigator =
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function";

    const secureContext =
      typeof window !== "undefined" && typeof window.isSecureContext === "boolean"
        ? window.isSecureContext
        : true;
    const currentOrigin = typeof window !== "undefined" && window.location ? window.location.origin : "unknown";
    const isTauri = getTauri() !== null;

    try {
      if (missingNavigator) {
        throw new Error("Microphone capture is not supported in this environment");
      }
      console.log("[Voice][Web] Microphone preflight", {
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
          "[Voice][Web] Insecure context reported under Tauri; attempting getUserMedia anyway",
          { currentOrigin }
        );
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
      if (context.state === "suspended") {
        await context.resume();
      }

      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const gain = context.createGain();
      gain.gain.value = 0;

      refs.current = {
        started: true,
        stream,
        context,
        source,
        processor,
        gain,
      };

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

        if (isMutedRef.current) {
          return;
        }

        const nowMs = Date.now();
        segmenterRef.current?.pushVolumeLevel(normalized, nowMs);
        const segmenter = segmenterRef.current;
        if (segmenter) {
          const speakingNow = segmenter.getIsSpeaking();
          const detectingNow = segmenter.getIsDetecting();
          const shouldLog =
            nowMs - vadLogRef.current.lastLogMs >= 150 ||
            speakingNow !== vadLogRef.current.lastSpeaking ||
            detectingNow !== vadLogRef.current.lastDetecting;
          if (shouldLog) {
            const threshold = vadConfigRef.current.volumeThreshold;
            const releaseThreshold = segmenter.getVolumeReleaseThreshold();
            console.log("[Voice][Web][VAD] level", {
              volume: Number(normalized.toFixed(3)),
              threshold: Number(threshold.toFixed(3)),
              releaseThreshold: Number(releaseThreshold.toFixed(3)),
              confirmedDropGraceMs: config.confirmedDropGracePeriod ?? 250,
              isSpeaking: speakingNow,
              isDetecting: detectingNow,
            });
            vadLogRef.current.lastLogMs = nowMs;
            vadLogRef.current.lastSpeaking = speakingNow;
            vadLogRef.current.lastDetecting = detectingNow;
          }
        }

        const pcm16 = resampleToPcm16(input, context.sampleRate, 16000);
        const pcmBytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
        segmenterRef.current?.pushPcmChunk(pcmBytes);
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(context.destination);

      setIsActive(true);
      return;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacksRef.current.onError?.(err);
      await stopInternal();
      throw err;
    }
  }, [stopInternal]);

  const stop = useCallback(async () => {
    await stopInternal();
  }, [stopInternal]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const nextMuted = !prev;
      if (nextMuted) {
        segmenterRef.current?.reset();
        setIsSpeaking(false);
        setIsDetecting(false);
      }
      return nextMuted;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (refs.current.started) {
        void stopInternal();
      }
    };
  }, [stopInternal]);

  return useMemo(
    () => ({
      start,
      stop,
      toggleMute,
      isActive,
      isSpeaking,
      isDetecting,
      isMuted,
      volume,
      segmentDuration,
    }),
    [start, stop, toggleMute, isActive, isSpeaking, isDetecting, isMuted, volume, segmentDuration]
  );
}
