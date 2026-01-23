export type DictationAudioSourceConfig = {
  onPcmSegment: (pcm16Base64: string) => void;
  onError?: (error: Error) => void;
};

export type DictationAudioSource = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  volume: number;
};

