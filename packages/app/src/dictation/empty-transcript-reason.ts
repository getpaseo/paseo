/** What the client knows after a dictation finishes without text. */
export type DictationEmptyReason = "no-audio" | "no-transcript";

export function resolveDictationEmptyReason(input: { segmentCount: number }): DictationEmptyReason {
  return input.segmentCount === 0 ? "no-audio" : "no-transcript";
}
