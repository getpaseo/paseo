import { useCallback, useEffect, useRef, useState } from "react";

import { DictationStreamSender } from "@/dictation/dictation-stream-sender";
import { useDictationAudioSource } from "@/hooks/use-dictation-audio-source";
import { generateMessageId } from "@/types/stream";
import { AttemptGuard } from "@/utils/attempt-guard";
import {
  DURATION_TICK_MS,
  PCM_DICTATION_FORMAT,
  toError,
  type DictationStatus,
  type UseDictationOptions,
  type UseDictationResult,
} from "./use-dictation.shared";

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const {
    client,
    onTranscript,
    onPartialTranscript,
    onError,
    onPermanentFailure,
    canStart,
    canConfirm,
    autoStopWhenHidden,
    enableDuration = false,
  } = options;

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DictationStatus>("idle");

  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const onPartialTranscriptRef = useRef(onPartialTranscript);
  useEffect(() => {
    onPartialTranscriptRef.current = onPartialTranscript;
  }, [onPartialTranscript]);

  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const onPermanentFailureRef = useRef(onPermanentFailure);
  useEffect(() => {
    onPermanentFailureRef.current = onPermanentFailure;
  }, [onPermanentFailure]);

  const isRecordingRef = useRef(isRecording);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const isProcessingRef = useRef(isProcessing);
  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // duration is used for UI only; no need to mirror into a ref.

  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptGuardRef = useRef(new AttemptGuard());
  const actionGateRef = useRef<{ starting: boolean; confirming: boolean; cancelling: boolean }>({
    starting: false,
    confirming: false,
    cancelling: false,
  });

  const senderRef = useRef<DictationStreamSender | null>(null);
  if (!senderRef.current) {
    senderRef.current = new DictationStreamSender({
      client,
      format: PCM_DICTATION_FORMAT,
      createDictationId: generateMessageId,
    });
  }
  useEffect(() => {
    senderRef.current?.setClient(client);
  }, [client]);

  const stopDurationTracking = useCallback(() => {
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  const startDurationTracking = useCallback(() => {
    if (!enableDuration) {
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
      if (normalized.name === "AttemptCancelledError") {
        return;
      }
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

  const clearStreamingState = useCallback(() => {
    senderRef.current?.clearAll();
    setPartialTranscript("");
  }, []);

  const startNewStream = useCallback(
    async (reason: string) => {
      await senderRef.current?.restartStream(reason);
    },
    []
  );

  const ensureFinalTranscript = useCallback(
    async (finalSeq: number): Promise<string> => {
      const result = await senderRef.current!.finish(finalSeq);
      return result.text;
    },
    []
  );

  useEffect(() => {
    if (!client) {
      return;
    }
    return client.subscribeConnectionStatus((next) => {
      if (next.status !== "connected") {
        return;
      }
      if (!isRecordingRef.current) {
        return;
      }
      void startNewStream("reconnect");
    });
  }, [client, startNewStream]);

  useEffect(() => {
    if (!client) {
      return;
    }
    return client.on("dictation_stream_partial", (message) => {
      if (message.type !== "dictation_stream_partial") {
        return;
      }
      const activeDictationId = senderRef.current?.getDictationId();
      if (!activeDictationId) {
        return;
      }
      if (message.payload.dictationId !== activeDictationId) {
        return;
      }
      const next = message.payload.text ?? "";
      setPartialTranscript(next);
      onPartialTranscriptRef.current?.(next, { requestId: generateMessageId() });
    });
  }, [client]);

  const audio = useDictationAudioSource({
    onPcmSegment: (audioData) => {
      senderRef.current?.enqueueSegment(audioData);
    },
    onError: (err) => {
      onErrorRef.current?.(err);
    },
  });
  const audioStopRef = useRef(audio.stop);
  useEffect(() => {
    audioStopRef.current = audio.stop;
  }, [audio.stop]);

  const handleStreamingTranscriptionSuccess = useCallback(
    (text: string, requestId: string) => {
      setIsProcessing(false);
      setPartialTranscript("");
      setDuration(0);
      setStatus("idle");

      clearStreamingState();

      const transcriptText = text.trim();
      if (!transcriptText) {
        return;
      }
      onTranscriptRef.current?.(transcriptText, { requestId });
    },
    [clearStreamingState]
  );

  const handleDictationFailure = useCallback(
    (failure: unknown) => {
      const normalized = toError(failure);
      const failureId = generateMessageId();
      setIsProcessing(false);
      isRecordingRef.current = false;
      setIsRecording(false);

      if (senderRef.current?.hasSegments()) {
        setStatus("failed");
        onPermanentFailureRef.current?.(normalized, { requestId: failureId });
      } else {
        setStatus("idle");
      }

      reportError(normalized, "Failed to complete dictation");
    },
    [reportError]
  );

  const startDictation = useCallback(async () => {
    if (actionGateRef.current.starting || actionGateRef.current.confirming || actionGateRef.current.cancelling) {
      return;
    }
    if (isRecordingRef.current || isProcessingRef.current) {
      return;
    }
    const startAllowed = canStart ? canStart() : true;
    if (!startAllowed) {
      return;
    }

    actionGateRef.current.starting = true;
    setError(null);
    setPartialTranscript("");
    setDuration(0);
    setIsProcessing(false);
    setStatus("recording");
    clearStreamingState();

    try {
      await audio.start();
      if (client?.isConnected) {
        void startNewStream("start");
      }
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
    } finally {
      actionGateRef.current.starting = false;
    }
  }, [
    audio,
    canStart,
    clearStreamingState,
    client,
    enableDuration,
    isProcessing,
    reportError,
    startDurationTracking,
    startNewStream,
    stopDurationTracking,
  ]);

  const cancelDictation = useCallback(async () => {
    attemptGuardRef.current.cancel();
    if (actionGateRef.current.cancelling) {
      return;
    }
    if (!isRecordingRef.current && !isProcessingRef.current) {
      return;
    }
    actionGateRef.current.cancelling = true;
    stopDurationTracking();
    setDuration(0);
    setError(null);

    try {
      try {
        senderRef.current?.cancel();
      } catch {
        // no-op
      }
      await audio.stop();
    } catch (err) {
      reportError(err, "Failed to cancel dictation");
    } finally {
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsProcessing(false);
      isProcessingRef.current = false;
      setStatus("idle");
      clearStreamingState();
      actionGateRef.current.cancelling = false;
    }
  }, [audio, clearStreamingState, client, reportError, stopDurationTracking]);

  const confirmDictation = useCallback(async () => {
    if (actionGateRef.current.confirming) {
      return;
    }
    if (!isRecordingRef.current || isProcessingRef.current) {
      return;
    }
    const confirmAllowed = canConfirm ? canConfirm() : true;
    if (!confirmAllowed) {
      return;
    }

    actionGateRef.current.confirming = true;
    setError(null);
    stopDurationTracking();
    setIsProcessing(true);
    isProcessingRef.current = true;

    const attemptId = attemptGuardRef.current.next();

    try {
      await audio.stop();
      attemptGuardRef.current.assertCurrent(attemptId);

      setStatus("uploading");
      isRecordingRef.current = false;
      setIsRecording(false);

      const finalSeq = senderRef.current?.getFinalSeq() ?? -1;
      if (finalSeq < 0) {
        handleStreamingTranscriptionSuccess("", generateMessageId());
        return;
      }

      const transcriptText = await ensureFinalTranscript(finalSeq);
      attemptGuardRef.current.assertCurrent(attemptId);
      handleStreamingTranscriptionSuccess(transcriptText, generateMessageId());
    } catch (err) {
      if (err instanceof Error && err.name === "AttemptCancelledError") {
        return;
      }
      handleDictationFailure(err);
    } finally {
      actionGateRef.current.confirming = false;
    }
  }, [
    audio,
    canConfirm,
    isProcessing,
    handleDictationFailure,
    handleStreamingTranscriptionSuccess,
    stopDurationTracking,
    ensureFinalTranscript,
  ]);

  const retryFailedDictation = useCallback(async () => {
    if (!senderRef.current?.hasSegments()) {
      return;
    }
    setError(null);
    setStatus("uploading");
    setIsProcessing(true);
    isProcessingRef.current = true;

    try {
      if (!client?.isConnected) {
        throw new Error("Daemon client is disconnected");
      }
      senderRef.current.resetStreamForReplay();
      const finalSeq = senderRef.current.getFinalSeq();
      const text = await ensureFinalTranscript(finalSeq);
      handleStreamingTranscriptionSuccess(text, generateMessageId());
    } catch (err) {
      if (err instanceof Error && err.name === "AttemptCancelledError") {
        return;
      }
      handleDictationFailure(err);
    }
  }, [client, ensureFinalTranscript, handleDictationFailure, handleStreamingTranscriptionSuccess]);

  const discardFailedDictation = useCallback(() => {
    setIsProcessing(false);
    isProcessingRef.current = false;
    setDuration(0);
    setStatus("idle");
    setError(null);
    clearStreamingState();
  }, [clearStreamingState]);

  const reset = useCallback(() => {
    setIsRecording(false);
    isRecordingRef.current = false;
    setIsProcessing(false);
    isProcessingRef.current = false;
    stopDurationTracking();
    setDuration(0);
    setError(null);
    setStatus("idle");
    clearStreamingState();
  }, [clearStreamingState, stopDurationTracking]);

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
    const nextVisible = typeof autoStopWhenHidden?.isVisible === "boolean" ? autoStopWhenHidden.isVisible : null;
    const prevVisible = visibilityRef.current;
    visibilityRef.current = nextVisible;

    if (prevVisible === true && nextVisible === false) {
      attemptGuardRef.current.cancel();

      if (isRecordingRef.current) {
        cancelRef.current?.();
        return;
      }

      if (isProcessingRef.current) {
        stopDurationTracking();
        setDuration(0);
        setIsProcessing(false);
        setError(null);
        setStatus("idle");
        clearStreamingState();
      }
    }
  }, [autoStopWhenHidden?.isVisible, clearStreamingState, stopDurationTracking]);

  useEffect(() => {
    return () => {
      attemptGuardRef.current.cancel();
      stopDurationTracking();
      void audioStopRef.current().catch(() => undefined);
    };
  }, [stopDurationTracking]);

  return {
    isRecording,
    isProcessing,
    partialTranscript,
    volume: audio.volume,
    duration,
    error,
    status,
    startDictation,
    cancelDictation,
    confirmDictation,
    retryFailedDictation,
    discardFailedDictation,
    reset,
  };
}

export type {
  DictationStatus,
  UseDictationOptions,
  UseDictationResult,
} from "./use-dictation.shared";
