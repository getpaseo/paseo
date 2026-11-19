import { createDictationRecordingBackend } from "./backend";
import { createDictationRecordingStore, type DictationRecordingStore } from "./store";

let store: DictationRecordingStore | null = null;

/** The device's recent dictations, shared by the composer and Settings. */
export function getDictationRecordingStore(): DictationRecordingStore {
  store ??= createDictationRecordingStore(createDictationRecordingBackend());
  return store;
}

export type { DictationRecording, DictationRecordingOutcome } from "./types";
export type { DictationRecordingStore } from "./store";
