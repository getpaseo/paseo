/** @vitest-environment jsdom */
import { Buffer } from "buffer";
import { act, renderHook } from "@testing-library/react";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationAudioSourceConfig } from "./use-dictation-audio-source.types";
import { useDictation, type UseDictationOptions } from "./use-dictation";

const audioSource = vi.hoisted(() => ({
  config: null as DictationAudioSourceConfig | null,
}));

vi.mock("@/hooks/use-dictation-audio-source", () => ({
  useDictationAudioSource: (config: DictationAudioSourceConfig) => {
    audioSource.config = config;
    return {
      start: async () => undefined,
      stop: async () => undefined,
      volume: 0,
      isPaused: false,
    };
  },
}));

const recordings = vi.hoisted(() => ({
  store: null as import("@/dictation/recordings").DictationRecordingStore | null,
}));

vi.mock("@/dictation/recordings", async () => {
  const { createDictationRecordingStore } = await import("@/dictation/recordings/store");
  type Recording = import("@/dictation/recordings").DictationRecording;
  const metadata = new Map<string, Recording>();
  const audio = new Map<string, string[]>();
  recordings.store = createDictationRecordingStore({
    listMetadata: async () => [...metadata.values()],
    writeMetadata: async (recording) => void metadata.set(recording.id, recording),
    writeSegments: async (id, segments) => void audio.set(id, segments),
    readSegments: async (id) => audio.get(id) ?? null,
    remove: async (id) => {
      metadata.delete(id);
      audio.delete(id);
    },
  });
  return { getDictationRecordingStore: () => recordings.store };
});

async function savedRecordings() {
  // Saves and outcome updates run after the hook's state settles.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return recordings.store!.list();
}

function pcm16Base64(samples: number[]): string {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes.toString("base64");
}

class FakeDictationClient {
  isConnected = true;
  transcript = "";
  finishes: Array<{ dictationId: string; finalSeq: number }> = [];
  private readonly rawListeners = new Set<(message: SessionOutboundMessage) => void>();

  async startDictationStream(): Promise<void> {}

  sendDictationStreamChunk(dictationId: string, seq: number): void {
    const ack = { type: "dictation_stream_ack", payload: { dictationId, ackSeq: seq } };
    for (const listener of this.rawListeners) {
      listener(ack as SessionOutboundMessage);
    }
  }

  async finishDictationStream(dictationId: string, finalSeq: number) {
    this.finishes.push({ dictationId, finalSeq });
    return { dictationId, text: this.transcript };
  }

  cancelDictationStream(): void {}

  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void {
    this.rawListeners.add(handler);
    return () => this.rawListeners.delete(handler);
  }

  subscribeConnectionStatus(): () => void {
    return () => undefined;
  }

  on(): () => void {
    return () => undefined;
  }
}

function renderDictation(client: FakeDictationClient) {
  const onTranscript = vi.fn();
  const view = renderHook(() =>
    useDictation({
      client: client as unknown as UseDictationOptions["client"],
      onTranscript,
    }),
  );
  return { view, onTranscript };
}

async function record(view: ReturnType<typeof renderDictation>["view"], segments: string[]) {
  await act(async () => {
    await view.result.current.startDictation();
  });
  await act(async () => {
    for (const segment of segments) {
      audioSource.config?.onPcmSegment(segment);
    }
  });
  await act(async () => {
    await view.result.current.confirmDictation();
  });
}

describe("useDictation empty results", () => {
  beforeEach(() => {
    audioSource.config = null;
  });

  it("explains a silent recording and keeps its audio for retry", async () => {
    const client = new FakeDictationClient();
    const { view, onTranscript } = renderDictation(client);

    await record(view, [pcm16Base64([0, 40, -60]), pcm16Base64([10, -20, 0])]);

    expect(view.result.current.status).toBe("empty");
    expect(view.result.current.emptyReason).toBe("silent-audio");
    expect(onTranscript).not.toHaveBeenCalled();

    client.transcript = "hello there";
    await act(async () => {
      await view.result.current.retryFailedDictation();
    });

    expect(client.finishes.map((finish) => finish.finalSeq)).toEqual([1, 1]);
    expect(onTranscript).toHaveBeenCalledWith("hello there", expect.anything());
    expect(view.result.current.status).toBe("idle");
    expect(view.result.current.emptyReason).toBeNull();
  });

  it("says when audible speech produced no text", async () => {
    const client = new FakeDictationClient();
    const { view } = renderDictation(client);

    await record(view, [pcm16Base64([0, 9000, -12000])]);

    expect(view.result.current.status).toBe("empty");
    expect(view.result.current.emptyReason).toBe("no-speech");
  });

  it("says when the microphone delivered no audio", async () => {
    const client = new FakeDictationClient();
    const { view } = renderDictation(client);

    await record(view, []);

    expect(view.result.current.status).toBe("empty");
    expect(view.result.current.emptyReason).toBe("no-audio");
    expect(client.finishes).toEqual([]);
  });

  it("clears the empty result when dismissed", async () => {
    const client = new FakeDictationClient();
    const { view } = renderDictation(client);

    await record(view, [pcm16Base64([5, 5])]);
    act(() => {
      view.result.current.discardFailedDictation();
    });

    expect(view.result.current.status).toBe("idle");
    expect(view.result.current.emptyReason).toBeNull();
  });
});

describe("useDictation saved recordings", () => {
  beforeEach(async () => {
    audioSource.config = null;
    for (const recording of await recordings.store!.list()) {
      await recordings.store!.remove(recording.id);
    }
  });

  it("keeps an empty result's audio and updates the same entry after retry", async () => {
    const client = new FakeDictationClient();
    const { view } = renderDictation(client);
    const segments = [pcm16Base64([0, 40]), pcm16Base64([-30, 10])];

    await record(view, segments);

    const [saved] = await savedRecordings();
    expect(saved.outcome).toEqual({ kind: "empty", reason: "silent-audio" });
    expect(await recordings.store!.loadSegments(saved.id)).toEqual(segments);

    client.transcript = "second try";
    await act(async () => {
      await view.result.current.retryFailedDictation();
    });

    expect(await savedRecordings()).toEqual([
      { ...saved, outcome: { kind: "transcribed", text: "second try" } },
    ]);
  });

  it("does not keep a recording the user cancelled", async () => {
    const { view } = renderDictation(new FakeDictationClient());
    await act(async () => {
      await view.result.current.startDictation();
    });
    act(() => {
      audioSource.config?.onPcmSegment(pcm16Base64([9000]));
    });
    await act(async () => {
      await view.result.current.cancelDictation();
    });

    expect(await savedRecordings()).toEqual([]);
  });
});
