import { describe, expect, it } from "vitest";
import {
  resolveLiveVoiceVoiceForCall,
  resolveLiveVoiceVoiceOptions,
} from "./live-voice-voice-catalog";

describe("Live Voice catalog", () => {
  it("uses the choices reported by every connected host", () => {
    expect(
      resolveLiveVoiceVoiceOptions([
        ["cove", "juniper", "maple"],
        ["juniper", "maple", "spruce"],
      ]),
    ).toEqual(["juniper", "maple"]);
  });

  it("uses the compatible fallback when no host catalog is available", () => {
    expect(resolveLiveVoiceVoiceOptions([])).toEqual([
      "juniper",
      "maple",
      "spruce",
      "ember",
      "vale",
      "breeze",
      "arbor",
      "sol",
      "cove",
    ]);
  });

  it("accepts an upstream voice without requiring it in Paseo's fallback", async () => {
    await expect(
      resolveLiveVoiceVoiceForCall({
        selectedVoice: "new-upstream-voice",
        listVoices: async () => ["new-upstream-voice"],
      }),
    ).resolves.toBe("new-upstream-voice");
  });

  it("drops a persisted legacy voice rejected by the target catalog", async () => {
    await expect(
      resolveLiveVoiceVoiceForCall({
        selectedVoice: "shimmer",
        listVoices: async () => ["cove", "juniper"],
      }),
    ).resolves.toBeUndefined();
  });
});
