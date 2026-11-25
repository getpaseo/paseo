import { expect, test } from "vitest";
import { createNativeEngineLease, type NativeAudioEngineLifecycle } from "./native-engine-lease";

// Mirrors the iOS and Android modules: one engine per app, `initialize()` reuses it,
// `tearDown()` frees it, and `toggleRecording(true)` returns false once it is gone.
function fakeNativeModule(options: { initializeResult?: boolean } = {}) {
  let engine: object | null = null;
  const calls = { initialize: 0, tearDown: 0 };
  let finishInitialize: (() => void) | null = null;
  let deferInitialize = false;
  const native: NativeAudioEngineLifecycle & {
    toggleRecording(value: boolean): boolean;
  } = {
    initialize() {
      calls.initialize += 1;
      const complete = () => {
        if (options.initializeResult === false) {
          return false;
        }
        engine ??= {};
        return true;
      };
      if (!deferInitialize) {
        return Promise.resolve(complete());
      }
      return new Promise<boolean>((resolve) => {
        finishInitialize = () => resolve(complete());
      });
    },
    tearDown() {
      calls.tearDown += 1;
      engine = null;
    },
    toggleRecording(value: boolean) {
      return engine !== null && value;
    },
  };
  return {
    native,
    calls,
    deferNextInitialize() {
      deferInitialize = true;
    },
    finishInitialize() {
      finishInitialize?.();
    },
  };
}

test("dictation releasing the engine keeps it for voice mode", async () => {
  const fake = fakeNativeModule();
  const lease = createNativeEngineLease(fake.native);

  await lease.acquire(); // voice mode
  await lease.acquire(); // dictation
  lease.release(); // dictation unmounts

  expect(fake.calls.tearDown).toBe(0);
  expect(fake.native.toggleRecording(true)).toBe(true);
});

test("the last release tears the native engine down and the next acquire rebuilds it", async () => {
  const fake = fakeNativeModule();
  const lease = createNativeEngineLease(fake.native);

  await lease.acquire();
  lease.release();
  expect(fake.calls.tearDown).toBe(1);
  expect(fake.native.toggleRecording(true)).toBe(false);

  await lease.acquire();
  expect(fake.calls.initialize).toBe(2);
  expect(fake.native.toggleRecording(true)).toBe(true);
});

test("concurrent acquires share one native initialize", async () => {
  const fake = fakeNativeModule();
  fake.deferNextInitialize();
  const lease = createNativeEngineLease(fake.native);

  const first = lease.acquire();
  const second = lease.acquire();
  fake.finishInitialize();
  await Promise.all([first, second]);

  expect(fake.calls.initialize).toBe(1);
  lease.release();
  expect(fake.calls.tearDown).toBe(0);
  lease.release();
  expect(fake.calls.tearDown).toBe(1);
});

test("a failed initialize is not counted as a holder and can be retried", async () => {
  const fake = fakeNativeModule({ initializeResult: false });
  const lease = createNativeEngineLease(fake.native);

  await expect(lease.acquire()).rejects.toThrow("native initialize() returned false");
  lease.release();
  expect(fake.calls.tearDown).toBe(0);

  await expect(lease.acquire()).rejects.toThrow();
  expect(fake.calls.initialize).toBe(2);
});

test("a release with no holders is a no-op", async () => {
  const fake = fakeNativeModule();
  const lease = createNativeEngineLease(fake.native);

  await lease.acquire();
  lease.release();
  lease.release();
  await lease.acquire();
  lease.release();

  expect(fake.calls.tearDown).toBe(2);
});
