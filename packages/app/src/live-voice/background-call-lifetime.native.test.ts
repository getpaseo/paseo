import { describe, expect, it, vi } from "vitest";

const expoModules = vi.hoisted(() => ({
  requireNativeModule: vi.fn(() => {
    throw new Error("PaseoBackgroundCall is unavailable");
  }),
}));

vi.mock("expo-modules-core", () => expoModules);

import { beginLiveVoiceBackgroundCall } from "./background-call-lifetime.native";

describe("native background-call lifetime", () => {
  it("does not require the native module until Live Voice starts", async () => {
    expect(expoModules.requireNativeModule).not.toHaveBeenCalled();

    await expect(beginLiveVoiceBackgroundCall()).rejects.toThrow(
      "PaseoBackgroundCall is unavailable",
    );
    expect(expoModules.requireNativeModule).toHaveBeenCalledOnce();
  });
});
