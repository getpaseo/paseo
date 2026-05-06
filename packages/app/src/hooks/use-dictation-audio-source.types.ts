export interface DictationAudioSourceConfig {
  onPcmSegment: (pcm16Base64: string) => void;
  onError?: (error: Error) => void;
}

export interface DictationAudioSource {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  volume: number;
}
