import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  begin: vi.fn(async () => undefined),
  end: vi.fn(async () => undefined),
}));

const expoModules = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn<() => unknown>(() => null),
}));

vi.mock("expo-modules-core", () => expoModules);

import {
  beginLiveVoiceBackgroundCall,
  endLiveVoiceBackgroundCall,
  isLiveVoiceBackgroundCallSupported,
} from "./background-call-lifetime.native";

describe("native background-call lifetime", () => {
  beforeEach(() => {
    expoModules.requireOptionalNativeModule.mockReset();
    expoModules.requireOptionalNativeModule.mockReturnValue(null);
    nativeModule.begin.mockClear();
    nativeModule.end.mockClear();
  });

  it("reports background mode as unsupported when the app binary lacks the module", async () => {
    expect(expoModules.requireOptionalNativeModule).not.toHaveBeenCalled();
    expect(isLiveVoiceBackgroundCallSupported()).toBe(false);

    await expect(beginLiveVoiceBackgroundCall()).rejects.toThrow(
      "Live Voice background mode is unavailable in this app binary",
    );
    expect(expoModules.requireOptionalNativeModule).toHaveBeenCalledTimes(2);
  });

  it("delegates lifetime ownership when the native module is installed", async () => {
    expoModules.requireOptionalNativeModule.mockReturnValue(nativeModule);

    expect(isLiveVoiceBackgroundCallSupported()).toBe(true);
    await beginLiveVoiceBackgroundCall();
    await endLiveVoiceBackgroundCall();

    expect(nativeModule.begin).toHaveBeenCalledOnce();
    expect(nativeModule.end).toHaveBeenCalledOnce();
  });
});
