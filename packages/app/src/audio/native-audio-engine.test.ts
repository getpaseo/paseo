import { expect, test } from "vitest";
import type { AudioEngineCallbacks } from "./audio-engine-types";
import { createNativeAudioEngine, type NativeAudioEngineDeps } from "./native-audio-engine";

// In-memory stand-in for `@getpaseo/expo-two-way-audio`, matching its iOS and Android modules:
// one native engine per app, `initialize()` reuses it, `tearDown()` frees it, and
// `toggleRecording(true)` / `startDictation()` return false while no engine exists.
// Session handling follows iOS: recording activates the OS audio session, stopping does not
// deactivate it, and `releaseAudioSession()` deactivates it only while nothing is recording.
function fakeTwoWayAudio({
  captureAvailable = true,
  permissionRequestError,
}: { captureAvailable?: boolean; permissionRequestError?: Error } = {}) {
  let engine: { recording: boolean; sessionActive: boolean } | null = null;
  const calls = { initialize: 0, tearDown: 0 };
  const native: NativeAudioEngineDeps["native"] = {
    async initialize() {
      calls.initialize += 1;
      engine ??= { recording: false, sessionActive: false };
      return true;
    },
    tearDown() {
      calls.tearDown += 1;
      engine = null;
    },
    toggleRecording(value: boolean) {
      if (!engine) return false;
      engine.recording = value;
      if (value) engine.sessionActive = true;
      return value;
    },
    startDictation() {
      if (!engine || !captureAvailable) return false;
      engine.recording = true;
      engine.sessionActive = true;
      return true;
    },
    releaseAudioSession() {
      if (engine && !engine.recording) engine.sessionActive = false;
    },
    playPCMData() {},
    resumePlayback() {},
    stopPlayback() {},
    async getMicrophonePermissionsAsync() {
      return { granted: !permissionRequestError };
    },
    async requestMicrophonePermissionsAsync() {
      if (permissionRequestError) throw permissionRequestError;
      return { granted: true };
    },
    addExpoTwoWayAudioEventListener() {
      return { remove() {} };
    },
  };
  return {
    native,
    calls,
    hasEngine: () => engine !== null,
    sessionActive: () => engine?.sessionActive ?? false,
  };
}

const recordingCallbacks: AudioEngineCallbacks = {
  onCaptureData() {},
  onVolumeLevel() {},
};

function deps(native: NativeAudioEngineDeps["native"]): NativeAudioEngineDeps {
  return {
    native,
    playEncodedAudio: async () => 0,
  };
}

// Issue #4147: on iPhone, voice mode failed with "Android audio focus is unavailable"
// after the dictation engine was destroyed.
test("voice capture starts after the dictation engine is destroyed", async () => {
  const fake = fakeTwoWayAudio();
  const voiceEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks);
  await voiceEngine.initialize();

  const dictationEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks, {
    captureMode: "dictation",
  });
  await dictationEngine.startCapture();
  await dictationEngine.stopCapture();
  await dictationEngine.destroy();

  await expect(voiceEngine.startCapture()).resolves.toBeUndefined();
});

test("destroying dictation while voice is capturing keeps the native engine", async () => {
  const fake = fakeTwoWayAudio();
  const voiceEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks);
  await voiceEngine.startCapture();

  const dictationEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks, {
    captureMode: "dictation",
  });
  await dictationEngine.initialize();
  await dictationEngine.destroy();

  expect(fake.hasEngine()).toBe(true);
  expect(fake.calls.tearDown).toBe(0);
});

// Review on #9051: with voice holding the engine, destroying an active dictation engine must
// still hand back the idle OS audio session so background music resumes (#2866).
test("destroying active dictation releases the idle audio session while voice keeps the engine", async () => {
  const fake = fakeTwoWayAudio();
  const voiceEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks);
  await voiceEngine.initialize();

  const dictationEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks, {
    captureMode: "dictation",
  });
  await dictationEngine.startCapture();
  await dictationEngine.destroy();

  expect(fake.hasEngine()).toBe(true);
  expect(fake.sessionActive()).toBe(false);
});

test("destroying dictation does not release the session while voice is recording", async () => {
  const fake = fakeTwoWayAudio();
  const voiceEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks);
  await voiceEngine.startCapture();

  const dictationEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks, {
    captureMode: "dictation",
  });
  await dictationEngine.initialize();
  await dictationEngine.destroy();

  expect(fake.sessionActive()).toBe(true);
});

test("destroying the last engine tears the native engine down", async () => {
  const fake = fakeTwoWayAudio();
  const voiceEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks);
  const dictationEngine = createNativeAudioEngine(deps(fake.native), recordingCallbacks, {
    captureMode: "dictation",
  });
  await voiceEngine.initialize();
  await dictationEngine.initialize();

  await dictationEngine.destroy();
  await voiceEngine.destroy();

  expect(fake.calls.tearDown).toBe(1);
  expect(fake.hasEngine()).toBe(false);
});

test("an engine destroyed while initializing does not keep the native engine", async () => {
  const fake = fakeTwoWayAudio();
  const engine = createNativeAudioEngine(deps(fake.native), recordingCallbacks);

  const initializing = expect(engine.initialize()).rejects.toThrow("Audio engine destroyed");
  await engine.destroy();
  await initializing;

  expect(fake.hasEngine()).toBe(false);
});

test("a failed native recording start rejects with a platform-neutral error", async () => {
  const fake = fakeTwoWayAudio({ captureAvailable: false });
  const engine = createNativeAudioEngine(deps(fake.native), recordingCallbacks, {
    captureMode: "dictation",
  });

  await expect(engine.startCapture()).rejects.toThrow(/^Microphone capture could not start\.$/);
  await engine.destroy();
});

test("a failed native permission request retains the permission reason and original error", async () => {
  const permissionRequestError = new Error("The current activity is not available.");
  const fake = fakeTwoWayAudio({ permissionRequestError });
  const engine = createNativeAudioEngine(deps(fake.native), recordingCallbacks, {
    captureMode: "dictation",
  });

  await expect(engine.startCapture()).rejects.toMatchObject({
    reason: "permissionDenied",
    cause: permissionRequestError,
  });
  expect(fake.hasEngine()).toBe(false);
  await engine.destroy();
});
