import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionContextValue } from "@/contexts/session-context";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import { useSessionRpc } from "@/hooks/use-session-rpc";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import { generateMessageId } from "@/types/stream";

export type UseDictationOptions = {
  agentId: string;
  sendAgentAudio: SessionContextValue["sendAgentAudio"];
  ws: UseWebSocketReturn;
  mode?: "transcribe_only" | "auto_run";
  onTranscript: (text: string, meta: { requestId: string }) => void;
  onError?: (error: Error) => void;
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
  startDictation: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  confirmDictation: () => Promise<void>;
  reset: () => void;
};

const DURATION_TICK_MS = 1000;

const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return new Error(error);
  }
  return new Error("An unexpected error occurred while handling dictation.");
};

export function useDictation(options: UseDictationOptions): UseDictationResult {
  const {
    agentId,
    sendAgentAudio,
    ws,
    mode = "transcribe_only",
    onTranscript,
    onError,
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

  const { waitForResponse: waitForTranscriptionResponse, reset: resetTranscriptionRpc } = useSessionRpc({
    ws,
    requestType: "send_agent_audio",
    responseType: "transcription_result",
  });

  const handleAudioLevel = useCallback((level: number) => {
    setVolume(level);
  }, []);

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
    setDuration(0);
    setIsProcessing(true);

    try {
      const audioData = await stopRecorder();
      isRecordingRef.current = false;
      setIsRecording(false);
      setVolume(0);

      const requestId = generateMessageId();
      pendingRequestIdRef.current = requestId;
      setPendingRequestId(requestId);
      const transcription = await waitForTranscriptionResponse({
        requestId,
        dispatch: () => sendAgentAudio(agentId, audioData, requestId, { mode }),
      });

      pendingRequestIdRef.current = null;
      setPendingRequestId(null);
      setIsProcessing(false);

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
    } catch (err) {
      pendingRequestIdRef.current = null;
      setPendingRequestId(null);
      setIsProcessing(false);
      isRecordingRef.current = false;
      setIsRecording(false);
      setVolume(0);
      resetTranscriptionRpc();
      reportError(err, "Failed to complete dictation");
    }
  }, [
    agentId,
    canConfirm,
    isProcessing,
    mode,
    onTranscriptRef,
    reportError,
    resetTranscriptionRpc,
    sendAgentAudio,
    stopDurationTracking,
    stopRecorder,
    waitForTranscriptionResponse,
  ]);

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
    resetTranscriptionRpc();
  }, [resetTranscriptionRpc, stopDurationTracking]);

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
    resetTranscriptionRpc();
  }, [agentId, resetTranscriptionRpc]);

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
    startDictation,
    cancelDictation,
    confirmDictation,
    reset,
  };
}
