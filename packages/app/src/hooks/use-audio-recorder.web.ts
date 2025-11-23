import { useCallback, useEffect, useRef, useState } from "react";

export interface AudioCaptureConfig {
  sampleRate?: number;
  numberOfChannels?: number;
  bitRate?: number;
  onAudioLevel?: (level: number) => void;
  onSpeechSegment?: (audioBlob: Blob) => void;
  enableContinuousRecording?: boolean;
}

const MIME_TYPE_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

export function useAudioRecorder(config?: AudioCaptureConfig) {
  const [isRecording, setIsRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const supportedMimeTypeRef = useRef<string | null | undefined>(undefined);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const configRef = useRef<AudioCaptureConfig | undefined>(config);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const detectSupportedMimeType = useCallback((): string | null => {
    if (supportedMimeTypeRef.current !== undefined) {
      return supportedMimeTypeRef.current;
    }

    if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined") {
      supportedMimeTypeRef.current = null;
      return null;
    }

    const detected = MIME_TYPE_CANDIDATES.find((candidate) =>
      window.MediaRecorder.isTypeSupported(candidate)
    );

    supportedMimeTypeRef.current = detected ?? null;
    return supportedMimeTypeRef.current;
  }, []);

  const stopMetering = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    analyserRef.current?.disconnect();
    analyserRef.current = null;

    if (audioContextRef.current) {
      // Closing can reject if context already closed; ignore.
      void audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
  }, []);

  const cleanupStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors.
        }
      });
      mediaStreamRef.current = null;
    }
  }, []);

  const startMetering = useCallback((stream: MediaStream) => {
    const onAudioLevel = configRef.current?.onAudioLevel;
    if (!onAudioLevel) {
      return;
    }

    const AudioContextCtor =
      (typeof window !== "undefined" &&
        ((window as typeof window & { webkitAudioContext?: typeof AudioContext }).AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext)) ||
      null;

    if (!AudioContextCtor) {
      console.warn("[AudioRecorder][Web] AudioContext unavailable for metering");
      return;
    }

    try {
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      analyserRef.current = analyser;
      audioContextRef.current = audioContext;

      const dataArray = new Uint8Array(analyser.fftSize);

      const tick = () => {
        analyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const value = (dataArray[i] - 128) / 128;
          sumSquares += value * value;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        const normalized = Math.min(1, Math.max(0, rms * 2));
        onAudioLevel(normalized);
        rafIdRef.current = requestAnimationFrame(tick);
      };

      tick();
    } catch (error) {
      console.warn("[AudioRecorder][Web] Failed to start metering", error);
    }
  }, []);

  const start = useCallback(async () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      throw new Error("Already recording");
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      throw new Error("Microphone capture is not supported in this environment");
    }

    const options = configRef.current;
    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: options?.numberOfChannels ?? 1,
        sampleRate: options?.sampleRate,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error: any) {
      throw new Error(`Failed to access microphone: ${error?.message ?? error}`);
    }

    mediaStreamRef.current = stream;

    const recorderOptions: MediaRecorderOptions = {};
    const mimeType = detectSupportedMimeType();
    if (mimeType) {
      recorderOptions.mimeType = mimeType;
    }
    if (options?.bitRate) {
      recorderOptions.audioBitsPerSecond = options.bitRate;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, recorderOptions);
    } catch (error: any) {
      cleanupStream();
      throw new Error(`Failed to initialize recorder: ${error?.message ?? error}`);
    }

    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
        if (options?.enableContinuousRecording && options?.onSpeechSegment) {
          options.onSpeechSegment(event.data);
        }
      }
    };

    recorder.onerror = (event) => {
      const error = (event as { error?: Error }).error;
      console.error("[AudioRecorder][Web] Recorder error", error ?? event);
    };

    const timeslice = options?.enableContinuousRecording ? 1000 : undefined;

    startMetering(stream);
    setIsRecording(true);

    if (timeslice !== undefined) {
      recorder.start(timeslice);
    } else {
      recorder.start();
    }
  }, [cleanupStream, detectSupportedMimeType, startMetering]);

  const stop = useCallback(async (): Promise<Blob> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      throw new Error("Not recording");
    }

    return await new Promise<Blob>((resolve, reject) => {
      const finalize = () => {
        recorder.removeEventListener("stop", finalize);
        recorder.removeEventListener("error", handleError as EventListener);

        stopMetering();
        cleanupStream();
        mediaRecorderRef.current = null;
        setIsRecording(false);

        const mimeType = recorder.mimeType || detectSupportedMimeType() || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        resolve(blob);
      };

      const handleError = (event: unknown) => {
        recorder.removeEventListener("stop", finalize);
        recorder.removeEventListener("error", handleError as EventListener);

        stopMetering();
        cleanupStream();
        mediaRecorderRef.current = null;
        chunksRef.current = [];
        setIsRecording(false);

        const error =
          typeof event === "object" && event && "error" in event
            ? (event as { error?: Error }).error
            : null;
        reject(error ?? new Error("Failed to stop recording"));
      };

      recorder.addEventListener("stop", finalize);
      recorder.addEventListener("error", handleError as EventListener);

      try {
        recorder.stop();
      } catch (error) {
        recorder.removeEventListener("stop", finalize);
        recorder.removeEventListener("error", handleError as EventListener);
        handleError(error);
      }
    });
  }, [cleanupStream, detectSupportedMimeType, stopMetering]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore stop during unmount.
        }
      }
      stopMetering();
      cleanupStream();
    };
  }, [cleanupStream, stopMetering]);

  const getSupportedMimeType = useCallback(() => detectSupportedMimeType(), [
    detectSupportedMimeType,
  ]);

  return {
    start,
    stop,
    isRecording: () => isRecording,
    getSupportedMimeType,
  };
}
