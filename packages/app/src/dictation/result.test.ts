import { describe, expect, it } from "vitest";
import { completeDictation, type DictationRecording } from "./result";

class RecordedAudio implements DictationRecording {
  constructor(private segments: string[]) {}
  getSegmentCount() {
    return this.segments.length;
  }
  clearAll() {
    this.segments = [];
  }
}

describe("completing dictation", () => {
  it("keeps a recording through repeated empty results until a retry returns text", () => {
    const recording = new RecordedAudio(["first PCM chunk", "second PCM chunk"]);
    const empty = { finalText: "  ", partialText: "", recording };
    const result = completeDictation(empty);
    expect(recording.getSegmentCount()).toBe(2);
    expect(result).toEqual({ status: "empty", reason: "no-transcript" });
    expect(completeDictation(empty)).toEqual({ status: "empty", reason: "no-transcript" });
    expect(recording.getSegmentCount()).toBe(2);
    expect(completeDictation({ ...empty, finalText: " recovered " })).toEqual({
      status: "transcribed",
      text: "recovered",
    });
    expect(recording.getSegmentCount()).toBe(0);
  });

  it("keeps usable partial text when the final response is empty", () => {
    const recording = new RecordedAudio(["PCM chunk"]);
    expect(
      completeDictation({ finalText: "", partialText: " recognized words ", recording }),
    ).toEqual({
      status: "transcribed",
      text: "recognized words",
    });
    expect(recording.getSegmentCount()).toBe(0);
  });

  it("reports a missing recording without inventing a reason for the empty result", () => {
    expect(
      completeDictation({ finalText: "", partialText: "", recording: new RecordedAudio([]) }),
    ).toEqual({
      status: "empty",
      reason: "no-audio",
    });
  });
});
