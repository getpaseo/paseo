import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/desktop/settings/desktop-settings", () => ({
  loadDesktopSettings: vi.fn(),
}));

import { loadDesktopSettings } from "@/desktop/settings/desktop-settings";

const mockLoadDesktopSettings = vi.mocked(loadDesktopSettings);

class MockAudio {
  static instances: MockAudio[] = [];

  src: string;
  preload = "";
  currentTime = 0;
  play = vi.fn(async () => undefined);
  pause = vi.fn();

  constructor(src: string) {
    this.src = src;
    MockAudio.instances.push(this);
  }
}

type AudioGlobal = Omit<typeof globalThis, "Audio"> & { Audio?: unknown };

function installAudio(constructor?: unknown): void {
  (globalThis as AudioGlobal).Audio = constructor;
}

async function loadNotificationSound() {
  return await import("./notification-sound");
}

describe("playNotificationSound", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockAudio.instances = [];
    mockLoadDesktopSettings.mockResolvedValue({
      releaseChannel: "stable",
      notifications: { playSound: true },
      daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: false },
    });
    installAudio(MockAudio);
  });

  afterEach(() => {
    delete (globalThis as AudioGlobal).Audio;
    vi.resetModules();
  });

  it("plays the bundled tone when sound is enabled", async () => {
    const { playNotificationSound } = await loadNotificationSound();

    const played = await playNotificationSound();

    expect(played).toBe(true);
    expect(MockAudio.instances).toHaveLength(1);
    const tone = MockAudio.instances[0];
    expect(tone?.src).toMatch(/^data:audio\/wav;base64,/);
    expect(tone?.play).toHaveBeenCalledTimes(1);
  });

  it("does not construct audio when sound is disabled", async () => {
    mockLoadDesktopSettings.mockResolvedValue({
      releaseChannel: "stable",
      notifications: { playSound: false },
      daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: false },
    });
    const audioConstructor = vi.fn();
    installAudio(audioConstructor);

    const { playNotificationSound } = await loadNotificationSound();
    const played = await playNotificationSound();

    expect(played).toBe(false);
    expect(audioConstructor).not.toHaveBeenCalled();
  });

  it("still plays when settings fail to load", async () => {
    mockLoadDesktopSettings.mockRejectedValue(new Error("ipc unavailable"));

    const { playNotificationSound } = await loadNotificationSound();
    const played = await playNotificationSound();

    expect(played).toBe(true);
    expect(MockAudio.instances).toHaveLength(1);
  });

  it("returns false when the Audio API is unavailable", async () => {
    installAudio(undefined);
    const { playNotificationSound } = await loadNotificationSound();
    const played = await playNotificationSound();

    expect(played).toBe(false);
    expect(mockLoadDesktopSettings).toHaveBeenCalledTimes(1);
  });

  it("restarts and reuses a single element across plays", async () => {
    const { playNotificationSound } = await loadNotificationSound();

    await playNotificationSound();
    await playNotificationSound();

    expect(MockAudio.instances).toHaveLength(1);
    const tone = MockAudio.instances[0];
    expect(tone?.pause).toHaveBeenCalled();
    expect(tone?.currentTime).toBe(0);
    expect(tone?.play).toHaveBeenCalledTimes(2);
  });

  it("returns false when playback is rejected", async () => {
    const { playNotificationSound } = await loadNotificationSound();
    // First call caches the element; make its play() reject.
    await playNotificationSound();
    const tone = MockAudio.instances[0];
    expect(tone).toBeDefined();
    tone?.play.mockRejectedValueOnce(new Error("autoplay blocked"));

    const replayed = await playNotificationSound();

    expect(replayed).toBe(false);
  });
});
