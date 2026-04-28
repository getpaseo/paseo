import ExpoTwoWayAudioModule from "./ExpoTwoWayAudioModule";

export type MicrophoneDataEvent = {
  data: Uint8Array;
};

export type VolumeLevelEvent = {
  data: number;
};

export type RecordingChangeEvent = {
  data: boolean;
};

export type AudioInterruptionEvent = {
  data: string;
};

export interface ExpoTwoWayAudioEventMap {
  onMicrophoneData: MicrophoneDataEvent;
  onInputVolumeLevelData: VolumeLevelEvent;
  onOutputVolumeLevelData: VolumeLevelEvent;
  onRecordingChange: RecordingChangeEvent;
  onAudioInterruption: AudioInterruptionEvent;
}

// These are useful for defining `useCallback` types inline
export type MicrophoneDataCallback = (event: MicrophoneDataEvent) => void;
export type VolumeLevelCallback = (event: VolumeLevelEvent) => void;
export type RecordingChangeCallback = (event: RecordingChangeEvent) => void;
export type AudioInterruptionCallback = (event: AudioInterruptionEvent) => void;

export function addExpoTwoWayAudioEventListener<K extends keyof ExpoTwoWayAudioEventMap>(
  eventName: K,
  handler: (ev: ExpoTwoWayAudioEventMap[K]) => void,
) {
  return ExpoTwoWayAudioModule.addListener(eventName, handler);
}
