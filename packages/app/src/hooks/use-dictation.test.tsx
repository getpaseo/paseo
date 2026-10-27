/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptCancelledError } from "@/utils/attempt-guard";
import type { UseDictationOptions } from "./use-dictation.shared";

// jsdom has no microphone: the source's start() returns a promise the test settles,
// standing in for a permission prompt or a getUserMedia call that is still pending.
const audioSource = vi.hoisted(() => {
  const state = {
    settleStart: null as null | { resolve: () => void; reject: (error: unknown) => void },
    start: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    stop: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
    onPcmSegment: null as null | ((audio: string) => void),
  };
  return state;
});

vi.mock("@/hooks/use-dictation-audio-source", () => ({
  useDictationAudioSource: (config: { onPcmSegment: (audio: string) => void }) => {
    audioSource.onPcmSegment = config.onPcmSegment;
    return {
      start: audioSource.start,
      stop: audioSource.stop,
      volume: 0,
      isPaused: false,
    };
  },
}));

const { useDictation } = await import("./use-dictation");

function createFakeClient() {
  return {
    isConnected: true,
    startDictationStream: vi.fn(async () => {}),
    sendDictationStreamChunk: vi.fn(),
    finishDictationStream: vi.fn(async (dictationId: string) => ({ dictationId, text: "" })),
    cancelDictationStream: vi.fn(),
    subscribeRawMessages: vi.fn(() => () => {}),
    subscribeConnectionStatus: vi.fn(() => () => {}),
    on: vi.fn(() => () => {}),
  };
}

function renderDictation(client: ReturnType<typeof createFakeClient>) {
  const onError = vi.fn();
  const onTranscript = vi.fn();
  const rendered = renderHook(() =>
    useDictation({
      client: client as unknown as UseDictationOptions["client"],
      onTranscript,
      onError,
    }),
  );
  return { ...rendered, onError, onTranscript };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  audioSource.settleStart = null;
  audioSource.start = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        audioSource.settleStart = { resolve, reject };
      }),
  );
  audioSource.stop = vi.fn(async () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDictation pending startup", () => {
  it("cancels a start that is still acquiring the microphone", async () => {
    const client = createFakeClient();
    const { result, onError } = renderDictation(client);

    act(() => {
      void result.current.startDictation();
    });
    expect(result.current.status).toBe("recording");
    expect(audioSource.settleStart).not.toBeNull();

    await act(async () => {
      await result.current.cancelDictation();
    });
    expect(result.current.status).toBe("idle");
    // The source is stopped while acquisition is pending, so it can release a late stream itself.
    expect(audioSource.stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      audioSource.settleStart?.resolve();
    });
    await flush();

    expect(audioSource.stop).toHaveBeenCalledTimes(2);
    expect(result.current.isRecording).toBe(false);
    expect(result.current.isRecordingActive()).toBe(false);
    expect(result.current.status).toBe("idle");
    expect(client.startDictationStream).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("treats the source's cancelled acquisition as a silent cancel", async () => {
    const client = createFakeClient();
    const { result, onError } = renderDictation(client);

    act(() => {
      void result.current.startDictation();
    });
    await act(async () => {
      await result.current.cancelDictation();
    });
    await act(async () => {
      audioSource.settleStart?.reject(new AttemptCancelledError());
    });
    await flush();

    expect(result.current.status).toBe("idle");
    expect(result.current.isRecording).toBe(false);
    expect(client.startDictationStream).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("stops the late-acquired microphone after an unmount during acquisition", async () => {
    const client = createFakeClient();
    const { result, unmount, onError } = renderDictation(client);

    act(() => {
      void result.current.startDictation();
    });
    unmount();
    const stopsAtUnmount = audioSource.stop.mock.calls.length;
    expect(stopsAtUnmount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      audioSource.settleStart?.resolve();
    });
    await flush();

    expect(audioSource.stop.mock.calls.length).toBe(stopsAtUnmount + 1);
    expect(client.startDictationStream).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("records and opens the stream when the start is not cancelled", async () => {
    const client = createFakeClient();
    const { result, onError } = renderDictation(client);

    act(() => {
      void result.current.startDictation();
    });
    await act(async () => {
      audioSource.settleStart?.resolve();
    });
    await flush();

    expect(result.current.isRecording).toBe(true);
    expect(result.current.status).toBe("recording");
    expect(client.startDictationStream).toHaveBeenCalledTimes(1);
    expect(audioSource.stop).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops the partial segment the source flushes while a recording is cancelled", async () => {
    const client = createFakeClient();
    // Stopping a real source flushes the audio it still holds.
    audioSource.stop = vi.fn(async () => {
      audioSource.onPcmSegment?.("AAAA");
    });
    const { result } = renderDictation(client);

    act(() => {
      void result.current.startDictation();
    });
    await act(async () => {
      audioSource.settleStart?.resolve();
    });
    await flush();
    expect(client.startDictationStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.cancelDictation();
    });
    await flush();

    expect(result.current.status).toBe("idle");
    expect(client.startDictationStream).toHaveBeenCalledTimes(1);
    expect(client.sendDictationStreamChunk).not.toHaveBeenCalled();
  });
});
