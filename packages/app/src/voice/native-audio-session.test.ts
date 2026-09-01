import { describe, expect, it } from "vitest";

import {
  createNativeAudioSession,
  NATIVE_AUDIO_CAPTURE_UNAVAILABLE,
  NATIVE_AUDIO_INITIALIZE_FAILED,
} from "@/voice/native-audio-session";
import { createFakeNativeAudioModule } from "@/voice/test-utils/fake-native-audio-module";

describe("native audio session ownership", () => {
  it("keeps recording available after another owner is destroyed", async () => {
    const { native, state } = createFakeNativeAudioModule();
    const session = createNativeAudioSession(native);

    const voice = session.createOwner();
    await voice.ensureReady();
    await voice.startRecording();
    voice.stopRecording();

    const dictation = session.createOwner();
    await dictation.ensureReady();
    dictation.release();

    expect(state.tearDownCalls).toBe(0);
    await expect(voice.startRecording()).resolves.toBeUndefined();
    expect(state.recording).toBe(true);
  });

  it("tears the engine down once the last owner releases", async () => {
    const { native, state } = createFakeNativeAudioModule();
    const session = createNativeAudioSession(native);

    const voice = session.createOwner();
    const dictation = session.createOwner();
    await voice.ensureReady();
    await dictation.ensureReady();

    dictation.release();
    expect(state.tearDownCalls).toBe(0);

    voice.release();
    expect(state.tearDownCalls).toBe(1);
    expect(state.engineExists).toBe(false);
  });

  it("releases only once per owner", async () => {
    const { native, state } = createFakeNativeAudioModule();
    const session = createNativeAudioSession(native);

    const voice = session.createOwner();
    const dictation = session.createOwner();
    await voice.ensureReady();
    await dictation.ensureReady();

    dictation.release();
    dictation.release();

    expect(state.tearDownCalls).toBe(0);
    expect(voice.isHolding()).toBe(true);
  });

  it("recreates the engine when it disappeared underneath an owner", async () => {
    const { native, state } = createFakeNativeAudioModule();
    const session = createNativeAudioSession(native);

    const voice = session.createOwner();
    await voice.startRecording();
    voice.stopRecording();

    // Something outside this session took the engine away.
    state.engineExists = false;

    await expect(voice.startRecording()).resolves.toBeUndefined();
    expect(state.initializeCalls).toBe(2);
    expect(state.recording).toBe(true);
  });

  it("reports capture as unavailable when audio focus is denied", async () => {
    const { native, state } = createFakeNativeAudioModule();
    state.focusDenied = true;
    const session = createNativeAudioSession(native);

    const voice = session.createOwner();

    await expect(voice.startRecording()).rejects.toThrow(NATIVE_AUDIO_CAPTURE_UNAVAILABLE);
    expect(state.recording).toBe(false);
  });

  it("surfaces a failed native initialize", async () => {
    const { native, state } = createFakeNativeAudioModule();
    state.initializeSucceeds = false;
    const session = createNativeAudioSession(native);

    await expect(session.createOwner().ensureReady()).rejects.toThrow(
      NATIVE_AUDIO_INITIALIZE_FAILED,
    );
  });

  it("initializes the engine once for concurrent owners", async () => {
    const { native, state } = createFakeNativeAudioModule();
    const session = createNativeAudioSession(native);

    await Promise.all([session.createOwner().ensureReady(), session.createOwner().ensureReady()]);

    expect(state.initializeCalls).toBe(1);
  });

  it("does not hold a reference before the engine is ready", async () => {
    const { native } = createFakeNativeAudioModule();
    const session = createNativeAudioSession(native);

    const voice = session.createOwner();
    expect(voice.isHolding()).toBe(false);

    await voice.ensureReady();
    expect(voice.isHolding()).toBe(true);

    voice.release();
    expect(voice.isHolding()).toBe(false);
  });
});
