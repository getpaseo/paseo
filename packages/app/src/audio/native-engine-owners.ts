interface NativeEngineModule {
  initialize(): Promise<boolean>;
  tearDown(): void;
}

export interface NativeEngineOwners {
  acquire(): Promise<void>;
  release(): void;
}

/**
 * The native two-way audio module holds one engine for the whole app, but voice mode and
 * dictation each create their own JS audio engine. Tear the native engine down only when the
 * last owner releases it. Otherwise dictation unmounting frees the engine under voice mode,
 * and voice capture fails until the app restarts.
 */
export function createNativeEngineOwners(native: NativeEngineModule): NativeEngineOwners {
  let owners = 0;

  function release(): void {
    if (owners === 0) {
      return;
    }
    owners -= 1;
    if (owners === 0) {
      native.tearDown();
    }
  }

  return {
    async acquire() {
      // Count the owner before awaiting, so a release during initialize() cannot tear down
      // the engine this owner is about to use.
      owners += 1;
      let success = false;
      try {
        success = await native.initialize();
      } finally {
        if (!success) {
          release();
        }
      }
      if (!success) {
        throw new Error("expo-two-way-audio: native initialize() returned false");
      }
    },
    release,
  };
}
