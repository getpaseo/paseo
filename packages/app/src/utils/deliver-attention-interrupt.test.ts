import { beforeEach, describe, expect, it, vi } from "vitest";

const playAttentionSound = vi.fn();
const sendOsNotification = vi.fn(async () => true);
const showBanner = vi.fn();
const focusWindow = vi.fn(async () => true);

vi.mock("@/utils/attention-sound", () => ({
  playAttentionSound,
  resolveAttentionSoundPreset: (preset: string) => preset,
}));

vi.mock("@/utils/os-notifications", () => ({
  sendOsNotification,
}));

vi.mock("@/stores/attention-banner-store", () => ({
  useAttentionBannerStore: {
    getState: () => ({
      show: showBanner,
      dismiss: vi.fn(),
      banner: null,
    }),
  },
}));

vi.mock("@/desktop/electron/window", () => ({
  getDesktopWindow: () => ({ focus: focusWindow }),
}));

vi.mock("@/data/query-client", () => ({
  queryClient: {
    getQueryData: () => ({
      attentionIntrusiveMode: false,
      attentionOsBubbleEnabled: true,
      attentionSoundEnabled: true,
      attentionSoundPreset: "soft",
    }),
  },
}));

vi.mock("@/hooks/use-settings/storage", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-settings/storage")>(
    "@/hooks/use-settings/storage",
  );
  return {
    ...actual,
    normalizeAppSettings: (value: unknown) => value as never,
    DEFAULT_CLIENT_SETTINGS: {
      attentionIntrusiveMode: false,
      attentionOsBubbleEnabled: true,
      attentionSoundEnabled: true,
      attentionSoundPreset: "soft",
    },
  };
});

describe("deliverAttentionInterrupt", () => {
  beforeEach(() => {
    playAttentionSound.mockClear();
    sendOsNotification.mockClear();
    showBanner.mockClear();
    focusWindow.mockClear();
  });

  it("plays in-app sound for the default focused-wrong-agent path even when bubble is on", async () => {
    const { deliverAttentionInterrupt } = await import("./deliver-attention-interrupt");

    await deliverAttentionInterrupt({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "s1", agentId: "a1", workspaceId: "w1" },
      target: { kind: "agent", id: "a1" },
      focusedAgentId: "other",
      focusedTerminalId: null,
      isActivelyVisible: true,
    });

    expect(showBanner).toHaveBeenCalledOnce();
    expect(sendOsNotification).toHaveBeenCalledWith(expect.objectContaining({ silent: false }));
    expect(playAttentionSound).toHaveBeenCalledWith("soft");
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it("does not play in-app sound for bubble-only unfocused defaults", async () => {
    const { deliverAttentionInterrupt } = await import("./deliver-attention-interrupt");

    await deliverAttentionInterrupt({
      title: "Agent finished",
      body: "Done",
      data: { serverId: "s1", agentId: "a1", workspaceId: "w1" },
      target: { kind: "agent", id: "a1" },
      focusedAgentId: null,
      focusedTerminalId: null,
      isActivelyVisible: false,
    });

    expect(showBanner).not.toHaveBeenCalled();
    expect(sendOsNotification).toHaveBeenCalledWith(expect.objectContaining({ silent: false }));
    expect(playAttentionSound).not.toHaveBeenCalled();
  });
});
