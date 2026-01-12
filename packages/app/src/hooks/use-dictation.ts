import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import type { SessionContextValue } from "@/contexts/session-context";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import type { DaemonClientV2 } from "@server/client/daemon-client-v2";
import type { TranscriptionResultMessage } from "@server/shared/messages";
import { generateMessageId } from "@/types/stream";

export type DictationStatus = "idle" | "recording" | "uploading" | "retrying" | "failed";

type DictationRetryReason = "dispatch" | "timeout" | "response" | "disconnected";

export type DictationRetryInfo = {
  attempt: number;
  maxAttempts: number;
  reason: DictationRetryReason;
  errorMessage: string;
  nextRetryMs: number;
};

export type FailedDictationRecording = {
  requestId: string;
  durationSeconds: number;
  sizeBytes: number;
  format: string;
  recordedAt: number;
  errorMessage: string;
};

export type DictationOutcome =
  | { type: "success"; requestId: string; timestamp: number }
  | { type: "failure"; requestId: string; errorMessage: string; timestamp: number };

export type UseDictationOptions = {
  agentId?: string;
  sendAgentAudio: SessionContextValue["sendAgentAudio"];
  client: DaemonClientV2 | null;
  mode?: "transcribe_only" | "auto_run";
  onTranscript: (text: string, meta: { requestId: string }) => void;
  onError?: (error: Error) => void;
  onRetryAttempt?: (info: DictationRetryInfo) => void;
  onPermanentFailure?: (error: Error, context: { requestId: string }) => void;
  canStart?: () => boolean;
  canConfirm?: () => boolean;
  autoStopWhenHidden?: { isVisible: boolean };
  enableDuration?: boolean;
};

export type UseDictationResult = {
  isRecording: boolean;
  isProcessing: boolean;
  volume: number;
  duration: number;
  pendingRequestId: string | null;
  error: string | null;
  status: DictationStatus;
  retryAttempt: number;
  maxRetryAttempts: number;
  retryInfo: DictationRetryInfo | null;
  failedRecording: FailedDictationRecording | null;
  lastOutcome: DictationOutcome | null;
  startDictation: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  confirmDictation: () => Promise<void>;
  retryFailedDictation: () => Promise<void>;
  discardFailedDictation: () => void;
  reset: () => void;
};

const DURATION_TICK_MS = 1000;
const MAX_AUTO_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 12000;
const RETRY_BACKOFF_FACTOR = 1.8;
const RETRY_JITTER_MS = 400;
const TRANSCRIPTION_TIMEOUT_MS = 120000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const computeRetryDelayMs = (attempt: number): number => {
  const exponential = RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** Math.max(0, attempt - 1);
  const capped = Math.min(RETRY_MAX_DELAY_MS, exponential);
  if (RETRY_JITTER_MS <= 0) {
    return capped;
  }
  return capped + Math.floor(Math.random() * RETRY_JITTER_MS);
};

const isTimeoutError = (error: Error): boolean =>
  /timed out|timeout/i.test(error.message);

class DictationAttemptError extends Error {
  public readonly reason: DictationRetryReason;

  constructor(reason: DictationRetryReason, error: Error) {
    super(error.message);
    this.name = "DictationAttemptError";
    this.reason = reason;
    (this as Error & { cause?: Error }).cause = error;
  }
}

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return new Error(error);
  }
  return new Error("An unexpected error occurred while handling dictation.");
};

type CapturedAudioPayload = {
  blob: Blob;
  format: string;
  sizeBytes: number;
  durationSeconds: number;
  recordedAt: number;
};

type TranscriptionPayload = TranscriptionResultMessage["payload"];

const deriveFormatFromMime = (mimeType?: string): string => {
  if (!mimeType || mimeType.length === 0) {
    return "webm";
  }
  const slashIndex = mimeType.indexOf("/");
  let formatPart = slashIndex >= 0 ? mimeType.slice(slashIndex + 1) : mimeType;
  const semicolonIndex = formatPart.indexOf(";");
  if (semicolonIndex >= 0) {
    formatPart = formatPart.slice(0, semicolonIndex);
  }
  return formatPart.trim().length > 0 ? formatPart.trim() : "webm";
};

const buildCapturedAudioPayload = (blob: Blob, durationSeconds: number): CapturedAudioPayload => ({
  blob,
  format: deriveFormatFromMime(blob.type),
  sizeBytes: typeof blob.size === "number" ? blob.size : 0,
  durationSeconds,
  recordedAt: Date.now(),
});

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const {
    agentId,
    sendAgentAudio,
    client,
    mode = "transcribe_only",
    onTranscript,
    onError,
    onRetryAttempt,
    onPermanentFailure,
    canStart,
    canConfirm,
    autoStopWhenHidden,
    enableDuration = false,
  } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [volume, setVolume] = useState(0);
  const [duration, setDuration] = useState(0);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [retryInfo, setRetryInfo] = useState<DictationRetryInfo | null>(null);
  const [failedRecording, setFailedRecording] = useState<FailedDictationRecording | null>(null);
  const [lastOutcome, setLastOutcome] = useState<DictationOutcome | null>(null);
  const maxRetryAttempts = MAX_AUTO_RETRY_ATTEMPTS;

  const transcriptionMutation = useMutation({
    mutationFn: async (requestId: string): Promise<TranscriptionPayload> => {
      const capturedAudio = pendingAudioRef.current;
      if (!capturedAudio) {
        throw new Error("No recorded audio available for transcription");
      }

      setRetryAttempt(1);
      setRetryInfo(null);

      let attempt = 1;

      while (attempt <= MAX_AUTO_RETRY_ATTEMPTS) {
        try {
          if (!client) {
            throw new DictationAttemptError(
              "disconnected",
              new Error("Daemon client unavailable")
            );
          }
          if (!client.isConnected) {
            throw new DictationAttemptError(
              "disconnected",
              new Error("Daemon client is disconnected")
            );
          }

          console.info("[useDictation] sending transcription request", {
            requestId,
            attempt,
            agentId,
            size: capturedAudio.sizeBytes,
            durationSeconds: capturedAudio.durationSeconds,
          });

          setStatus("uploading");
          setRetryAttempt(attempt);

          try {
            const transcriptionPromise = client.waitForTranscriptionResult(
              requestId,
              TRANSCRIPTION_TIMEOUT_MS
            );
            try {
              await sendAgentAudio(agentId, capturedAudio.blob, requestId, {
                mode,
              });
            } catch (error) {
              transcriptionPromise.catch(() => {});
              throw new DictationAttemptError("dispatch", toError(error));
            }

            return await transcriptionPromise;
          } catch (error) {
            const normalized = toError(error);
            const reason: DictationRetryReason = isTimeoutError(normalized)
              ? "timeout"
              : "response";
            throw new DictationAttemptError(reason, normalized);
          }
        } catch (error) {
          const attemptError =
            error instanceof DictationAttemptError
              ? error
              : new DictationAttemptError("response", toError(error));

          if (attempt >= MAX_AUTO_RETRY_ATTEMPTS) {
            throw attemptError;
          }

          const nextAttempt = attempt + 1;
          const delayMs = computeRetryDelayMs(nextAttempt);
          const info: DictationRetryInfo = {
            attempt: nextAttempt,
            maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
            reason: attemptError.reason,
            errorMessage: attemptError.message,
            nextRetryMs: delayMs,
          };

          setStatus("retrying");
          setRetryAttempt(nextAttempt);
          setRetryInfo(info);
          onRetryAttemptRef.current?.(info);
          console.warn("[useDictation] retry scheduled", {
            requestId,
            attempt: nextAttempt,
            maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
            reason: attemptError.reason,
            error: attemptError.message,
            nextRetryMs: delayMs,
          });

          await sleep(delayMs);
          attempt = nextAttempt;
        }
      }

      throw new Error("Failed to complete transcription");
    },
  });
  const {
    mutateAsync: runTranscription,
    reset: resetTranscriptionMutation,
  } = transcriptionMutation;

  const pendingAudioRef = useRef<CapturedAudioPayload | null>(null);
  const handleAudioLevel = useCallback((level: number) => {
    setVolume(level);
  }, []);

  const durationRef = useRef(0);
  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  const recorder = useAudioRecorder({ onAudioLevel: handleAudioLevel });
  const recorderRef = useRef(recorder);
  useEffect(() => {
    recorderRef.current = recorder;
  }, [recorder]);

  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const onRetryAttemptRef = useRef(onRetryAttempt);
  useEffect(() => {
    onRetryAttemptRef.current = onRetryAttempt;
  }, [onRetryAttempt]);

  const onPermanentFailureRef = useRef(onPermanentFailure);
  useEffect(() => {
    onPermanentFailureRef.current = onPermanentFailure;
  }, [onPermanentFailure]);

  const isRecordingRef = useRef(isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const pendingRequestIdRef = useRef<string | null>(null);
  const activeStopPromiseRef = useRef<Promise<Blob> | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopDurationTracking = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const startDurationTracking = useCallback(() => {
    if (!enableDuration) {
      console.log("[useDictation] startDictation blocked by canStart()");
      return;
    }
    if (durationIntervalRef.current) {
      return;
    }
    durationIntervalRef.current = setInterval(() => {
      setDuration((prev) => prev + 1);
    }, DURATION_TICK_MS);
  }, [enableDuration]);

  useEffect(() => {
    if (!enableDuration) {
      stopDurationTracking();
      setDuration(0);
    }
  }, [enableDuration, stopDurationTracking]);

  const reportError = useCallback(
    (err: unknown, context?: string) => {
      const normalized = toError(err);
      if (context) {
        console.error(`[useDictation] ${context}`, normalized);
      } else {
        console.error("[useDictation]", normalized);
      }
      setError(normalized.message);
      onErrorRef.current?.(normalized);
    },
    [setError]
  );

  const stopRecorder = useCallback(async (): Promise<Blob> => {
    if (activeStopPromiseRef.current) {
      return activeStopPromiseRef.current;
    }
    const recorderInstance = recorderRef.current;
    if (!recorderInstance) {
      throw new Error("Recorder unavailable");
    }
    const stopPromise = (async () => {
      try {
        return await recorderInstance.stop();
      } finally {
        activeStopPromiseRef.current = null;
      }
    })();
    activeStopPromiseRef.current = stopPromise;
    return stopPromise;
  }, []);

  const transmitDictation = useCallback(
    async (requestId: string) => runTranscription(requestId),
    [runTranscription]
  );

  const handleTranscriptionSuccess = useCallback(
    (transcription: TranscriptionPayload, requestId: string) => {
      pendingRequestIdRef.current = null;
      setPendingRequestId(null);
      setIsProcessing(false);
      setDuration(0);
      setStatus("idle");
      setRetryAttempt(0);
      setRetryInfo(null);
      setFailedRecording(null);
      pendingAudioRef.current = null;
      setLastOutcome({ type: "success", requestId, timestamp: Date.now() });

      const transcriptText = transcription.text?.trim();
      if (!transcriptText) {
        return;
      }

      console.log("[useDictation] transcription_result received", {
        requestId,
        textLength: transcriptText.length,
      });
      onTranscriptRef.current?.(transcriptText, {
        requestId: transcription.requestId ?? requestId,
      });
    },
    [onTranscriptRef]
  );

  const handleDictationFailure = useCallback(
    (failure: unknown, requestId: string | null) => {
      const normalized = toError(failure);
      pendingRequestIdRef.current = null;
      setPendingRequestId(null);
      setIsProcessing(false);
      isRecordingRef.current = false;
      setIsRecording(false);
      setVolume(0);
      setRetryInfo(null);

      const capturedAudio = pendingAudioRef.current;
      if (capturedAudio) {
        setStatus("failed");
        setFailedRecording({
          requestId: requestId ?? generateMessageId(),
          durationSeconds: capturedAudio.durationSeconds,
          sizeBytes: capturedAudio.sizeBytes,
          format: capturedAudio.format,
          recordedAt: capturedAudio.recordedAt,
          errorMessage: normalized.message,
        });
        if (requestId) {
          onPermanentFailureRef.current?.(normalized, { requestId });
        }
      } else {
        setStatus("idle");
      }

      setRetryAttempt(0);
      setLastOutcome({
        type: "failure",
        requestId: requestId ?? generateMessageId(),
        errorMessage: normalized.message,
        timestamp: Date.now(),
      });
      reportError(normalized, "Failed to complete dictation");
    },
    [onPermanentFailureRef, reportError]
  );

  const startDictation = useCallback(async () => {
    console.log("[useDictation] startDictation requested", {
      isRecording: isRecordingRef.current,
      isProcessing,
    });
    if (isRecordingRef.current || isProcessing) {
      console.log("[useDictation] startDictation aborted: already recording/processing", {
        isRecording: isRecordingRef.current,
        isProcessing,
      });
      return;
    }
    const startAllowed = canStart ? canStart() : true;
    if (!startAllowed) {
      console.log("[useDictation] startDictation blocked by canStart()");
      return;
    }

    setError(null);
    setVolume(0);
    setDuration(0);
    setIsProcessing(false);
    setStatus("recording");
    setRetryAttempt(0);
    setRetryInfo(null);
    setFailedRecording(null);
    pendingAudioRef.current = null;
    setLastOutcome(null);
    pendingRequestIdRef.current = null;
    setPendingRequestId(null);

    try {
      const recorderInstance = recorderRef.current;
      if (!recorderInstance) {
        throw new Error("Recorder unavailable");
      }
      await recorderInstance.start();
      console.log("[useDictation] recorder.start succeeded");
      isRecordingRef.current = true;
      setIsRecording(true);
      if (enableDuration) {
        startDurationTracking();
      }
    } catch (err) {
      stopDurationTracking();
      isRecordingRef.current = false;
      setIsRecording(false);
      reportError(err, "Failed to start dictation");
    }
  }, [
    canStart,
    enableDuration,
    isProcessing,
    reportError,
    startDurationTracking,
    stopDurationTracking,
  ]);

  const cancelDictation = useCallback(async () => {
    console.log("[useDictation] cancelDictation requested", {
      isRecording: isRecordingRef.current,
      hasActiveStop: Boolean(activeStopPromiseRef.current),
    });
    if (!isRecordingRef.current && !activeStopPromiseRef.current) {
      console.log("[useDictation] cancelDictation ignored: nothing to cancel");
      return;
    }
    stopDurationTracking();
    setDuration(0);
    setError(null);

    try {
      await stopRecorder();
    } catch (err) {
      reportError(err, "Failed to cancel dictation");
    } finally {
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsProcessing(false);
      setVolume(0);
      setStatus("idle");
      setRetryAttempt(0);
      setRetryInfo(null);
      pendingAudioRef.current = null;
      setFailedRecording(null);
      setLastOutcome(null);
    }
  }, [reportError, stopDurationTracking, stopRecorder]);

  const confirmDictation = useCallback(async () => {
    console.log("[useDictation] confirmDictation requested", {
      isRecording: isRecordingRef.current,
      isProcessing,
    });
    if (!isRecordingRef.current || isProcessing) {
      console.log("[useDictation] confirmDictation ignored: recording flag", {
        isRecording: isRecordingRef.current,
        isProcessing,
      });
      return;
    }
    const confirmAllowed = canConfirm ? canConfirm() : true;
    if (!confirmAllowed) {
      console.log("[useDictation] confirmDictation blocked by canConfirm()");
      return;
    }

    setError(null);
    stopDurationTracking();
    setIsProcessing(true);
    setRetryInfo(null);
    setRetryAttempt(0);
    setLastOutcome(null);

    let requestId: string | null = null;
    try {
      const audioData = await stopRecorder();
      const recordedDurationSeconds = durationRef.current;
      pendingAudioRef.current = buildCapturedAudioPayload(audioData, recordedDurationSeconds);
      setStatus("uploading");
      isRecordingRef.current = false;
      setIsRecording(false);
      setVolume(0);

      requestId = generateMessageId();
      pendingRequestIdRef.current = requestId;
      setPendingRequestId(requestId);

      const transcription = await transmitDictation(requestId);
      handleTranscriptionSuccess(transcription, requestId);
    } catch (err) {
      resetTranscriptionMutation();
      handleDictationFailure(err, requestId);
    }
  }, [
    agentId,
    canConfirm,
    isProcessing,
    mode,
    handleDictationFailure,
    handleTranscriptionSuccess,
    resetTranscriptionMutation,
    stopDurationTracking,
    stopRecorder,
    transmitDictation,
  ]);

  const retryFailedDictation = useCallback(async () => {
    if (!pendingAudioRef.current) {
      return;
    }
    setError(null);
    setRetryInfo(null);
    setRetryAttempt(0);
    setStatus("uploading");
    setIsProcessing(true);
    setLastOutcome(null);

    const requestId = generateMessageId();
    pendingRequestIdRef.current = requestId;
    setPendingRequestId(requestId);

    try {
      const transcription = await transmitDictation(requestId);
      handleTranscriptionSuccess(transcription, requestId);
    } catch (err) {
      resetTranscriptionMutation();
      handleDictationFailure(err, requestId);
    }
  }, [
    handleDictationFailure,
    handleTranscriptionSuccess,
    resetTranscriptionMutation,
    transmitDictation,
  ]);

  const discardFailedDictation = useCallback(() => {
    pendingAudioRef.current = null;
    pendingRequestIdRef.current = null;
    setPendingRequestId(null);
    setIsProcessing(false);
    setDuration(0);
    setFailedRecording(null);
    setStatus("idle");
    setRetryAttempt(0);
    setRetryInfo(null);
    setError(null);
    setLastOutcome(null);
  }, []);

  const reset = useCallback(() => {
    pendingRequestIdRef.current = null;
    setPendingRequestId(null);
    setIsRecording(false);
    isRecordingRef.current = false;
    setIsProcessing(false);
    stopDurationTracking();
    setDuration(0);
    setVolume(0);
    setError(null);
    setStatus("idle");
    setRetryAttempt(0);
    setRetryInfo(null);
    setFailedRecording(null);
    pendingAudioRef.current = null;
    setLastOutcome(null);
    resetTranscriptionMutation();
  }, [resetTranscriptionMutation, stopDurationTracking]);

  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    cancelRef.current = () => {
      void cancelDictation();
    };
  }, [cancelDictation]);

  const visibilityRef = useRef<boolean | null>(
    typeof autoStopWhenHidden?.isVisible === "boolean" ? autoStopWhenHidden.isVisible : null
  );
  useEffect(() => {
    const nextVisible =
      typeof autoStopWhenHidden?.isVisible === "boolean" ? autoStopWhenHidden.isVisible : null;
    const prevVisible = visibilityRef.current;
    visibilityRef.current = nextVisible;

    if (prevVisible === true && nextVisible === false && isRecordingRef.current) {
      cancelRef.current?.();
    }
  }, [autoStopWhenHidden?.isVisible]);

  useEffect(() => {
    pendingRequestIdRef.current = null;
    setPendingRequestId(null);
    setIsProcessing(false);
    pendingAudioRef.current = null;
    setStatus("idle");
    setRetryAttempt(0);
    setRetryInfo(null);
    setFailedRecording(null);
    resetTranscriptionMutation();
  }, [agentId, resetTranscriptionMutation]);

  useEffect(() => {
    return () => {
      stopDurationTracking();
      const activeStop = activeStopPromiseRef.current;
      if (activeStop) {
        void activeStop.catch(() => undefined);
        return;
      }
      const recorderInstance = recorderRef.current;
      if (recorderInstance?.isRecording?.()) {
        void recorderInstance.stop().catch(() => undefined);
      }
    };
  }, [stopDurationTracking]);

  return {
    isRecording,
    isProcessing,
    volume,
    duration,
    pendingRequestId,
    error,
    status,
    retryAttempt,
    maxRetryAttempts,
    retryInfo,
    failedRecording,
    lastOutcome,
    startDictation,
    cancelDictation,
    confirmDictation,
    retryFailedDictation,
    discardFailedDictation,
    reset,
  };
}
