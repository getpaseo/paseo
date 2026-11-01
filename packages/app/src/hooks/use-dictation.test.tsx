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
  let rawMessageHandler: ((message: unknown) => void) | null = null;
  return {
    isConnected: true,
    startDictationStream: vi.fn(async () => {}),
    // The daemon acknowledges each chunk, which lets finish() stop waiting for delivery.
    sendDictationStreamChunk: vi.fn((dictationId: string, seq: number) => {
      rawMessageHandler?.({ type: "dictation_stream_ack", payload: { dictationId, ackSeq: seq } });
    }),
    finishDictationStream: vi.fn(async (dictationId: string) => ({ dictationId, text: "" })),
    cancelDictationStream: vi.fn(),
    subscribeRawMessages: vi.fn((handler: (message: unknown) => void) => {
      rawMessageHandler = handler;
      return () => {
        rawMessageHandler = null;
      };
    }),
    subscribeConnectionStatus: vi.fn(() => () => {}),
    on: vi.fn(() => () => {}),
  };
}

/** A finish reply the test settles, standing in for a transcription still in progress. */
function holdFinish(client: ReturnType<typeof createFakeClient>) {
  const held: {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  } = { resolve: () => {}, reject: () => {} };
  client.finishDictationStream.mockImplementationOnce(
    (dictationId: string) =>
      new Promise((resolve, reject) => {
        held.resolve = (text) => resolve({ dictationId, text });
        held.reject = reject;
      }),
  );
  return held;
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

describe("useDictation retry", () => {
  // Records one segment, then lets confirm fail so the attempt waits on retry.
  async function failFirstConfirm(
    client: ReturnType<typeof createFakeClient>,
    result: { current: ReturnType<typeof useDictation> },
  ) {
    act(() => {
      void result.current.startDictation();
    });
    await act(async () => {
      audioSource.settleStart?.resolve();
    });
    await flush();
    act(() => {
      audioSource.onPcmSegment?.("AAAA");
    });
    client.finishDictationStream.mockRejectedValueOnce(new Error("Synthetic failure"));
    await act(async () => {
      await result.current.confirmDictation();
    });
    expect(result.current.status).toBe("failed");
  }

  it("delivers the transcript of a retry that is not cancelled", async () => {
    const client = createFakeClient();
    const { result, onTranscript } = renderDictation(client);
    await failFirstConfirm(client, result);

    client.finishDictationStream.mockImplementationOnce(async (dictationId: string) => ({
      dictationId,
      text: "retried words",
    }));
    await act(async () => {
      await result.current.retryFailedDictation();
    });

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript.mock.calls[0]?.[0]).toBe("retried words");
    expect(result.current.status).toBe("idle");
  });

  it("drops the transcript of a retry cancelled before its reply", async () => {
    const client = createFakeClient();
    const { result, onTranscript } = renderDictation(client);
    await failFirstConfirm(client, result);

    const held = holdFinish(client);
    act(() => {
      void result.current.retryFailedDictation();
    });
    await flush();
    expect(result.current.status).toBe("uploading");
    await act(async () => {
      await result.current.cancelDictation();
    });
    expect(result.current.status).toBe("idle");

    await act(async () => {
      held.resolve("cancelled retry words");
    });
    await flush();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("drops the failure of a retry cancelled before its reply", async () => {
    const client = createFakeClient();
    const { result, onError } = renderDictation(client);
    await failFirstConfirm(client, result);
    onError.mockClear();

    const held = holdFinish(client);
    act(() => {
      void result.current.retryFailedDictation();
    });
    await flush();
    await act(async () => {
      await result.current.cancelDictation();
    });

    await act(async () => {
      held.reject(new Error("Late failure"));
    });
    await flush();

    expect(onError).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("keeps a newer recording when a cancelled retry's reply arrives", async () => {
    const client = createFakeClient();
    const { result, onTranscript } = renderDictation(client);
    await failFirstConfirm(client, result);

    const held = holdFinish(client);
    act(() => {
      void result.current.retryFailedDictation();
    });
    await flush();
    await act(async () => {
      await result.current.cancelDictation();
    });
    act(() => {
      void result.current.startDictation();
    });
    await act(async () => {
      audioSource.settleStart?.resolve();
    });
    await flush();
    expect(result.current.status).toBe("recording");

    await act(async () => {
      held.reject(new Error("Late failure"));
    });
    await flush();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.status).toBe("recording");
    expect(result.current.isRecording).toBe(true);
  });

  it("drops the transcript of a retry when the owner unmounts before its reply", async () => {
    const client = createFakeClient();
    const { result, unmount, onTranscript } = renderDictation(client);
    await failFirstConfirm(client, result);

    const held = holdFinish(client);
    act(() => {
      void result.current.retryFailedDictation();
    });
    await flush();
    unmount();

    await act(async () => {
      held.resolve("unmounted retry words");
    });
    await flush();

    expect(onTranscript).not.toHaveBeenCalled();
  });
});
