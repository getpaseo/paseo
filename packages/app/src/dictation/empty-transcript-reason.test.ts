import { describe, expect, it } from "vitest";
import { resolveDictationEmptyReason } from "@/dictation/empty-transcript-reason";

describe("resolveDictationEmptyReason", () => {
  it("reports when the microphone delivered no audio", () => {
    expect(resolveDictationEmptyReason({ segmentCount: 0 })).toBe("no-audio");
  });

  it("does not infer the server's reason from recorded audio", () => {
    expect(resolveDictationEmptyReason({ segmentCount: 40 })).toBe("no-transcript");
  });
});
