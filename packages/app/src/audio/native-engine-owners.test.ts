import { expect, test } from "vitest";
import { createNativeEngineOwners } from "./native-engine-owners";

// Mirrors the iOS and Android modules: one engine per app, `initialize()` reuses it,
// `tearDown()` frees it, and `toggleRecording(true)` returns false once it is gone.
function fakeNativeModule() {
  let engine: object | null = null;
  const calls = { initialize: 0, tearDown: 0 };
  return {
    calls,
    async initialize() {
      calls.initialize += 1;
      engine ??= {};
      return true;
    },
    tearDown() {
      calls.tearDown += 1;
      engine = null;
    },
    toggleRecording(value: boolean) {
      return engine !== null && value;
    },
  };
}

test("one owner's release keeps the native engine for the other owner", async () => {
  const native = fakeNativeModule();
  const owners = createNativeEngineOwners(native);

  await owners.acquire(); // voice mode
  await owners.acquire(); // dictation
  owners.release(); // dictation unmounts

  expect(native.calls.tearDown).toBe(0);
  expect(native.toggleRecording(true)).toBe(true);

  owners.release();
  expect(native.calls.tearDown).toBe(1);
  expect(native.toggleRecording(true)).toBe(false);
});

test("a release while another owner is initializing does not free that owner's engine", async () => {
  const native = fakeNativeModule();
  const owners = createNativeEngineOwners(native);

  await owners.acquire();
  const second = owners.acquire();
  owners.release();
  await second;

  expect(native.calls.tearDown).toBe(0);
  expect(native.toggleRecording(true)).toBe(true);
});

test("the next owner gets a fresh engine after the last owner releases", async () => {
  const native = fakeNativeModule();
  const owners = createNativeEngineOwners(native);

  await owners.acquire();
  owners.release();
  await owners.acquire();

  expect(native.calls).toEqual({ initialize: 2, tearDown: 1 });
  expect(native.toggleRecording(true)).toBe(true);
});

test("a failed initialize does not count as an owner", async () => {
  const native = fakeNativeModule();
  let failNext = true;
  const owners = createNativeEngineOwners({
    initialize: async () => {
      if (failNext) {
        failNext = false;
        return false;
      }
      return native.initialize();
    },
    tearDown: native.tearDown,
  });

  await expect(owners.acquire()).rejects.toThrow(
    "expo-two-way-audio: native initialize() returned false",
  );
  await owners.acquire();
  owners.release();

  expect(native.toggleRecording(true)).toBe(false);
});
