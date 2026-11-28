/**
 * The part of `@getpaseo/expo-two-way-audio` that owns the native engine's lifetime.
 * Each platform keeps a single engine per app: `initialize()` reuses it, `tearDown()` frees it.
 */
export interface NativeAudioEngineLifecycle {
  initialize(): Promise<boolean>;
  tearDown(): void;
}

export interface NativeEngineLease {
  /** Ensure the native engine exists and count the caller as a holder. */
  acquire(): Promise<void>;
  /** Drop one holder; the native engine is torn down when the last holder releases. */
  release(): void;
}

/**
 * Voice mode and dictation each create their own JS audio engine, but both drive the one
 * native engine. Counting holders keeps one consumer's teardown from freeing the engine
 * the other still uses (issue #4147: voice mode on iOS could not start after dictation).
 */
export function createNativeEngineLease(native: NativeAudioEngineLifecycle): NativeEngineLease {
  let holders = 0;
  let ready: Promise<void> | null = null;

  async function initialize(): Promise<void> {
    const success = await native.initialize();
    if (!success) {
      throw new Error("expo-two-way-audio: native initialize() returned false");
    }
  }

  return {
    async acquire() {
      holders += 1;
      ready ??= initialize();
      try {
        await ready;
      } catch (error) {
        holders -= 1;
        ready = null;
        throw error;
      }
    },

    release() {
      if (holders === 0) {
        return;
      }
      holders -= 1;
      if (holders === 0) {
        ready = null;
        native.tearDown();
      }
    },
  };
}
