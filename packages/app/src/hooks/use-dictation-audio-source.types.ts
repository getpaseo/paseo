export interface DictationAudioSourceConfig {
  onPcmSegment: (pcm16Base64: string) => void;
  onError?: (error: Error) => void;
  onInterruption?: () => void;
}

export interface DictationAudioSource {
  start: () => Promise<void>;
  /** The caller awaits startup before stopping and owns unmount cleanup. */
  stop: () => Promise<void>;
  volume: number;
}
