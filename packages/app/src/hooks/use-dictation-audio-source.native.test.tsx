/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TwoWayAudio from "@getpaseo/expo-two-way-audio";
import type { AudioEngineCallbacks, AudioEngineOptions } from "@/audio/audio-engine-types";
import type { UseDictationOptions } from "./use-dictation.shared";

// The actual native audio source and engine under useDictation; only the OS audio
// module is fake, with its permission and initialize calls settled by the test.
const os = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    capturing: false,
    initialized: false,
    permission: null as null | ((granted: boolean) => void),
    initialize: null as null | (() => void),
    holdPermission: false,
    holdInitialize: false,
  };
  return state;
});

function createFakeNativeModule() {
  return {
    addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
    initialize: () => {
      os.calls.push("initialize");
      return new Promise<boolean>((resolve) => {
        const finish = () => {
          os.initialized = true;
          resolve(true);
        };
        if (os.holdInitialize) {
          os.initialize = finish;
        } else {
          finish();
        }
      });
    },
    getMicrophonePermissionsAsync: async () => ({ granted: !os.holdPermission }),
    requestMicrophonePermissionsAsync: () =>
      new Promise<{ granted: boolean }>((resolve) => {
        os.permission = (granted) => resolve({ granted });
      }),
    startDictation: () => {
      os.calls.push("startDictation");
      os.capturing = true;
      return true;
    },
    toggleRecording: (value: boolean) => {
      os.calls.push(`toggleRecording:${value}`);
      os.capturing = value;
      return value;
    },
    tearDown: () => {
      os.calls.push("tearDown");
      os.capturing = false;
      os.initialized = false;
    },
    releaseAudioSession: () => {},
  };
}

// The engine's file playback is not exercised; these keep Expo's runtime out of Node.
vi.mock("expo-audio", () => ({ createAudioPlayer: vi.fn(), setAudioModeAsync: vi.fn() }));
vi.mock("expo-file-system", () => ({ File: vi.fn(), Paths: {} }));
vi.mock("@/audio", async () => {
  const { createNativeAudioEngine } = await import("@/audio/audio-engine.native");
  return {
    createAudioEngine: (callbacks: AudioEngineCallbacks, options?: AudioEngineOptions) =>
      createNativeAudioEngine(
        createFakeNativeModule() as unknown as typeof TwoWayAudio,
        callbacks,
        options,
      ),
  };
});
vi.mock("@/hooks/use-dictation-audio-source", () => import("./use-dictation-audio-source.native"));

const { useDictation } = await import("./use-dictation");

function renderDictation() {
  const onError = vi.fn();
  const rendered = renderHook(() =>
    useDictation({
      client: null as UseDictationOptions["client"],
      onTranscript: () => {},
      onError,
    }),
  );
  return { ...rendered, onError };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  os.calls = [];
  os.capturing = false;
  os.initialized = false;
  os.permission = null;
  os.initialize = null;
  os.holdPermission = false;
  os.holdInitialize = false;
});

describe("native dictation source pending start", () => {
  it("starts capture when the start is not cancelled", async () => {
    const { result, onError } = renderDictation();

    await act(async () => {
      await result.current.startDictation();
    });

    expect(os.calls).toEqual(["initialize", "startDictation"]);
    expect(os.capturing).toBe(true);
    expect(result.current.isRecording).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not start capture when permission is granted after the owner unmounts", async () => {
    os.holdPermission = true;
    const { result, unmount, onError } = renderDictation();

    let start!: Promise<void>;
    act(() => {
      start = result.current.startDictation();
    });
    await flush();
    expect(os.permission).not.toBeNull();
    unmount();

    await act(async () => {
      os.permission?.(true);
      await start;
    });

    expect(os.calls).not.toContain("startDictation");
    expect(os.capturing).toBe(false);
    expect(os.initialized).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not start capture when permission is granted after a cancel, and starts again", async () => {
    os.holdPermission = true;
    const { result, onError } = renderDictation();

    let start!: Promise<void>;
    act(() => {
      start = result.current.startDictation();
    });
    await flush();
    await act(async () => {
      await result.current.cancelDictation();
    });
    await act(async () => {
      os.permission?.(true);
      await start;
    });

    expect(os.calls).not.toContain("startDictation");
    expect(os.capturing).toBe(false);
    expect(result.current.status).toBe("idle");
    expect(onError).not.toHaveBeenCalled();

    os.holdPermission = false;
    await act(async () => {
      await result.current.startDictation();
    });
    expect(os.calls.filter((call) => call === "startDictation")).toHaveLength(1);
    expect(os.capturing).toBe(true);
    expect(result.current.isRecording).toBe(true);
  });

  it("tears the native session down when initialization finishes after the owner unmounts", async () => {
    os.holdInitialize = true;
    const { result, unmount, onError } = renderDictation();

    let start!: Promise<void>;
    act(() => {
      start = result.current.startDictation();
    });
    await flush();
    expect(os.initialize).not.toBeNull();
    unmount();

    await act(async () => {
      os.initialize?.();
      await start;
    });

    expect(os.calls).toEqual(["initialize", "tearDown"]);
    expect(os.capturing).toBe(false);
    expect(os.initialized).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });
});
