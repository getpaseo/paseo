export type DictationEmptyReason = "no-audio" | "no-transcript";

export interface DictationRecording {
  getSegmentCount(): number;
  clearAll(): void;
}

export type DictationResult =
  | { status: "empty"; reason: DictationEmptyReason }
  | { status: "transcribed"; text: string };

export function completeDictation(input: {
  finalText: string;
  partialText: string;
  recording: DictationRecording;
}): DictationResult {
  const text = input.finalText.trim() || input.partialText.trim();
  if (!text) {
    return {
      status: "empty",
      reason: input.recording.getSegmentCount() === 0 ? "no-audio" : "no-transcript",
    };
  }
  input.recording.clearAll();
  return { status: "transcribed", text };
}
