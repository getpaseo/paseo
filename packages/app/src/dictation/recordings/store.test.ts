import { Buffer } from "buffer";
import { describe, expect, it, vi } from "vitest";
import { createDictationRecordingStore, pcmDurationMs } from "./store";
import type { DictationRecording, DictationRecordingBackend } from "./types";

class MemoryBackend implements DictationRecordingBackend {
  metadata = new Map<string, DictationRecording>();
  audio = new Map<string, string[]>();

  async listMetadata() {
    return [...this.metadata.values()];
  }
  async writeMetadata(recording: DictationRecording) {
    this.metadata.set(recording.id, recording);
  }
  async writeSegments(id: string, segments: string[]) {
    this.audio.set(id, segments);
  }
  async readSegments(id: string) {
    return this.audio.get(id) ?? null;
  }
  async remove(id: string) {
    this.metadata.delete(id);
    this.audio.delete(id);
  }
}

// One second of 16 kHz PCM16.
const ONE_SECOND = Buffer.alloc(32_000).toString("base64");

describe("dictation recording store", () => {
  it("saves a recording as pending with its audio and duration", async () => {
    const backend = new MemoryBackend();
    const store = createDictationRecordingStore(backend);

    await store.save({ id: "a", createdAt: 1, segments: [ONE_SECOND, ONE_SECOND] });

    expect(await store.list()).toEqual([
      { id: "a", createdAt: 1, durationMs: 2000, outcome: { kind: "pending" } },
    ]);
    expect(await store.loadSegments("a")).toEqual([ONE_SECOND, ONE_SECOND]);
  });

  it("records the outcome of each transcription attempt", async () => {
    const store = createDictationRecordingStore(new MemoryBackend());
    await store.save({ id: "a", createdAt: 1, segments: [ONE_SECOND] });

    await store.setOutcome("a", { kind: "empty", reason: "silent-audio" });
    expect((await store.list())[0].outcome).toEqual({ kind: "empty", reason: "silent-audio" });

    await store.setOutcome("a", { kind: "transcribed", text: "hello" });
    expect((await store.list())[0].outcome).toEqual({ kind: "transcribed", text: "hello" });
  });

  it("keeps only the newest recordings", async () => {
    const backend = new MemoryBackend();
    const store = createDictationRecordingStore(backend, { maxRecordings: 2 });

    await store.save({ id: "old", createdAt: 1, segments: [ONE_SECOND] });
    await store.save({ id: "mid", createdAt: 2, segments: [ONE_SECOND] });
    await store.save({ id: "new", createdAt: 3, segments: [ONE_SECOND] });

    expect((await store.list()).map((recording) => recording.id)).toEqual(["new", "mid"]);
    expect(backend.audio.has("old")).toBe(false);
  });

  it("ignores outcomes for recordings that were already removed", async () => {
    const backend = new MemoryBackend();
    const store = createDictationRecordingStore(backend);
    await store.save({ id: "a", createdAt: 1, segments: [ONE_SECOND] });
    await store.remove("a");

    await store.setOutcome("a", { kind: "transcribed", text: "late" });

    expect(await store.list()).toEqual([]);
  });

  it("notifies subscribers after each change", async () => {
    const store = createDictationRecordingStore(new MemoryBackend());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.save({ id: "a", createdAt: 1, segments: [ONE_SECOND] });
    await store.setOutcome("a", { kind: "failed", error: "offline" });
    await store.remove("a");
    unsubscribe();
    await store.save({ id: "b", createdAt: 2, segments: [ONE_SECOND] });

    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("pcmDurationMs", () => {
  it("measures decoded PCM bytes, not base64 length", () => {
    expect(pcmDurationMs([Buffer.alloc(16_000).toString("base64")])).toBe(500);
  });
});
