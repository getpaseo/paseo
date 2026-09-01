/**
 * Reference-counted ownership of the one native audio engine. `expo-two-way-audio` keeps a
 * single engine per process, and voice mode and dictation each wrap it, so tearing it down is
 * left to whichever owner releases last.
 */

/** The part of the native module that decides whether the engine exists. */
export interface NativeAudioSessionModule {
  initialize(): Promise<boolean>;
  tearDown(): void;
  toggleRecording(value: boolean): boolean;
}

export interface NativeAudioSessionOwner {
  /** Create the native engine if no other owner has, and claim a reference to it. */
  ensureReady(): Promise<void>;
  /** Claim a reference and start recording, recreating the engine if it went away. */
  startRecording(): Promise<void>;
  stopRecording(): void;
  /** Drop this owner's reference, tearing the engine down once nobody holds it. */
  release(): void;
  /** Whether this owner currently holds a reference. */
  isHolding(): boolean;
}

export interface NativeAudioSession {
  createOwner(): NativeAudioSessionOwner;
}

export const NATIVE_AUDIO_INITIALIZE_FAILED =
  "expo-two-way-audio: native initialize() returned false";
export const NATIVE_AUDIO_CAPTURE_UNAVAILABLE =
  "Microphone capture could not start because the audio engine is unavailable. Another app may be holding audio focus.";

export function createNativeAudioSession(native: NativeAudioSessionModule): NativeAudioSession {
  const holders = new Set<object>();
  let engineReady = false;
  let pendingInitialize: Promise<void> | null = null;

  async function initializeEngine(): Promise<void> {
    const success = await native.initialize();
    if (!success) {
      throw new Error(NATIVE_AUDIO_INITIALIZE_FAILED);
    }
    engineReady = true;
  }

  async function createEngine(): Promise<void> {
    if (engineReady) {
      return;
    }
    if (!pendingInitialize) {
      pendingInitialize = initializeEngine();
    }
    try {
      await pendingInitialize;
    } finally {
      pendingInitialize = null;
    }
  }

  return {
    createOwner(): NativeAudioSessionOwner {
      const owner = {};

      async function ensureReady(): Promise<void> {
        await createEngine();
        holders.add(owner);
      }

      return {
        ensureReady,

        async startRecording() {
          await ensureReady();
          if (native.toggleRecording(true)) {
            return;
          }
          // `false` means the engine vanished (iOS) or focus was denied (Android).
          engineReady = false;
          await createEngine();
          if (!native.toggleRecording(true)) {
            throw new Error(NATIVE_AUDIO_CAPTURE_UNAVAILABLE);
          }
        },

        stopRecording() {
          if (engineReady) {
            native.toggleRecording(false);
          }
        },

        release() {
          if (!holders.delete(owner)) {
            return;
          }
          if (holders.size === 0 && engineReady) {
            native.tearDown();
            engineReady = false;
          }
        },

        isHolding() {
          return holders.has(owner);
        },
      };
    },
  };
}
