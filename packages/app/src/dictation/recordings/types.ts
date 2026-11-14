import type { DictationEmptyReason } from "@/dictation/empty-transcript-reason";

export type DictationRecordingOutcome =
  // Saved before transcription started; still pending if the app quit or lost the host.
  | { kind: "pending" }
  | { kind: "transcribed"; text: string }
  | { kind: "empty"; reason: DictationEmptyReason }
  | { kind: "failed"; error: string };

export interface DictationRecording {
  id: string;
  createdAt: number;
  durationMs: number;
  outcome: DictationRecordingOutcome;
}

/** Device storage for recordings. Metadata and audio are kept apart so listing never reads audio. */
export interface DictationRecordingBackend {
  listMetadata(): Promise<DictationRecording[]>;
  writeMetadata(recording: DictationRecording): Promise<void>;
  writeSegments(id: string, segments: string[]): Promise<void>;
  readSegments(id: string): Promise<string[] | null>;
  remove(id: string): Promise<void>;
}
