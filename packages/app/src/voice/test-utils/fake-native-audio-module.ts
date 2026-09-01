import type { NativeAudioModule } from "@/voice/native-audio-module";

export interface FakeNativeAudioState {
  engineExists: boolean;
  recording: boolean;
  initializeCalls: number;
  tearDownCalls: number;
  /** Make `toggleRecording(true)` fail the way Android does when audio focus is denied. */
  focusDenied: boolean;
  initializeSucceeds: boolean;
}

export interface FakeNativeAudioModule {
  native: NativeAudioModule;
  state: FakeNativeAudioState;
  reset(): void;
}

/** Mirrors the native module: one engine per process, failures reported as `false`. */
export function createFakeNativeAudioModule(): FakeNativeAudioModule {
  const state: FakeNativeAudioState = {
    engineExists: false,
    recording: false,
    initializeCalls: 0,
    tearDownCalls: 0,
    focusDenied: false,
    initializeSucceeds: true,
  };

  const native: NativeAudioModule = {
    async initialize() {
      state.initializeCalls += 1;
      if (!state.initializeSucceeds) {
        return false;
      }
      state.engineExists = true;
      return true;
    },
    tearDown() {
      state.tearDownCalls += 1;
      state.engineExists = false;
      state.recording = false;
    },
    toggleRecording(value: boolean) {
      if (!state.engineExists || (value && state.focusDenied)) {
        return false;
      }
      state.recording = value;
      return value;
    },
    releaseAudioSession() {},
    resumePlayback() {},
    playPCMData() {},
    stopPlayback() {},
    async getMicrophonePermissionsAsync() {
      return { granted: true };
    },
    async requestMicrophonePermissionsAsync() {
      return { granted: true };
    },
    addExpoTwoWayAudioEventListener() {
      return { remove() {} };
    },
  };

  return {
    native,
    state,
    reset() {
      state.engineExists = false;
      state.recording = false;
      state.initializeCalls = 0;
      state.tearDownCalls = 0;
      state.focusDenied = false;
      state.initializeSucceeds = true;
    },
  };
}
