import { describe, expect, it, vi } from "vitest";

const nativeWebRtc = vi.hoisted(() => ({
  evaluated: vi.fn(),
}));

vi.mock("react-native-webrtc", () => {
  nativeWebRtc.evaluated();
  throw new Error("native WebRTC is unavailable");
});

describe("native Live Voice transport import", () => {
  it("does not evaluate WebRTC bindings while the app imports", async () => {
    await expect(import("./live-voice-session.native")).resolves.toBeDefined();
    expect(nativeWebRtc.evaluated).not.toHaveBeenCalled();
  });
});
