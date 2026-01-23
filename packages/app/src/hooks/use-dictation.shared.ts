export type DictationStatus = "idle" | "recording" | "uploading" | "failed";

export type UseDictationOptions = {
  client: import("@server/client/daemon-client-v2").DaemonClientV2 | null;
  onTranscript: (text: string, meta: { requestId: string }) => void;
  onError?: (error: Error) => void;
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
  error: string | null;
  status: DictationStatus;
  startDictation: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  confirmDictation: () => Promise<void>;
  retryFailedDictation: () => Promise<void>;
  discardFailedDictation: () => void;
  reset: () => void;
};

export const DURATION_TICK_MS = 1000;
export const PCM_DICTATION_FORMAT = "audio/pcm;rate=16000;bits=16";

export const toError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return new Error(error);
  }
  return new Error("An unexpected error occurred while handling dictation.");
};
