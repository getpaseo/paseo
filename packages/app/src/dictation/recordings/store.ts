import { Buffer } from "buffer";
import type {
  DictationRecording,
  DictationRecordingBackend,
  DictationRecordingOutcome,
} from "./types";

// Each recording is 16 kHz mono PCM16, about 1.9 MB per minute.
export const MAX_DICTATION_RECORDINGS = 20;
const PCM_BYTES_PER_SECOND = 16_000 * 2;

export function pcmDurationMs(segments: string[]): number {
  let bytes = 0;
  for (const segment of segments) {
    bytes += Buffer.byteLength(segment, "base64");
  }
  return Math.round((bytes / PCM_BYTES_PER_SECOND) * 1000);
}

export interface DictationRecordingStore {
  /** Newest first. */
  list(): Promise<DictationRecording[]>;
  save(input: { id: string; createdAt: number; segments: string[] }): Promise<void>;
  setOutcome(id: string, outcome: DictationRecordingOutcome): Promise<void>;
  loadSegments(id: string): Promise<string[] | null>;
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createDictationRecordingStore(
  backend: DictationRecordingBackend,
  options: { maxRecordings?: number } = {},
): DictationRecordingStore {
  const maxRecordings = options.maxRecordings ?? MAX_DICTATION_RECORDINGS;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const list = async () => {
    const recordings = await backend.listMetadata();
    return recordings.sort((a, b) => b.createdAt - a.createdAt);
  };

  return {
    list,
    async save({ id, createdAt, segments }) {
      // Audio first: metadata without audio would list a recording that can't be retried.
      await backend.writeSegments(id, segments);
      await backend.writeMetadata({
        id,
        createdAt,
        durationMs: pcmDurationMs(segments),
        outcome: { kind: "pending" },
      });
      const expired = (await list()).slice(maxRecordings);
      await Promise.all(expired.map((recording) => backend.remove(recording.id)));
      notify();
    },
    async setOutcome(id, outcome) {
      const existing = (await backend.listMetadata()).find((recording) => recording.id === id);
      if (!existing) {
        return;
      }
      await backend.writeMetadata({ ...existing, outcome });
      notify();
    },
    loadSegments: (id) => backend.readSegments(id),
    async remove(id) {
      await backend.remove(id);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
