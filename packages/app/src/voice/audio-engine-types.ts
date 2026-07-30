export interface AudioEngineCallbacks {
  onCaptureData(pcm: Uint8Array): void;
  onVolumeLevel(level: number): void;
  onInterruption?(): void;
  onError?(error: Error): void;
}

export interface AudioPlaybackSource {
  arrayBuffer(): Promise<ArrayBuffer>;
  size: number;
  type: string;
}

export interface AudioEngine {
  initialize(): Promise<void>;
  destroy(): Promise<void>;

  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  toggleMute(): boolean;
  isMuted(): boolean;

  play(audio: AudioPlaybackSource): Promise<number>;
  /**
   * Speed multiplier for playback. Applies to the segment currently playing and
   * to everything queued behind it. Pitch is NOT preserved — this is a raw
   * resampling rate, so keep it near 1 (read aloud caps at 2x).
   */
  setPlaybackRate(rate: number): void;
  stop(): void;
  clearQueue(): void;
  isPlaying(): boolean;
}
