import { describe, expect, it } from "vitest";
import { planAttentionInterrupt } from "./attention-interrupt-plan";

const defaultSettings = {
  attentionIntrusiveMode: false,
  attentionOsBubbleEnabled: true,
  attentionSoundEnabled: true,
  attentionSoundPreset: "soft" as const,
};

describe("planAttentionInterrupt", () => {
  it("suppresses when actively visible and focused on the agent", () => {
    expect(
      planAttentionInterrupt({
        settings: defaultSettings,
        isActivelyVisible: true,
        focusedAgentId: "a1",
        focusedTerminalId: null,
        target: { kind: "agent", id: "a1" },
      }),
    ).toMatchObject({
      suppress: true,
      showOsBubble: false,
      showBanner: false,
      intrusiveFocusAndNavigate: false,
      playSound: false,
    });
  });

  it("shows banner when focused in app on a different agent", () => {
    expect(
      planAttentionInterrupt({
        settings: defaultSettings,
        isActivelyVisible: true,
        focusedAgentId: "other",
        focusedTerminalId: null,
        target: { kind: "agent", id: "a1" },
      }),
    ).toMatchObject({
      suppress: false,
      showBanner: true,
      showOsBubble: true,
      intrusiveFocusAndNavigate: false,
      playSound: true,
    });
  });

  it("uses bubble + sound when unfocused with defaults", () => {
    expect(
      planAttentionInterrupt({
        settings: defaultSettings,
        isActivelyVisible: false,
        focusedAgentId: null,
        focusedTerminalId: null,
        target: { kind: "agent", id: "a1" },
      }),
    ).toMatchObject({
      suppress: false,
      showOsBubble: true,
      showBanner: false,
      intrusiveFocusAndNavigate: false,
      playSound: true,
    });
  });

  it("intrusive unfocused focuses and navigates", () => {
    expect(
      planAttentionInterrupt({
        settings: {
          ...defaultSettings,
          attentionIntrusiveMode: true,
          attentionOsBubbleEnabled: false,
        },
        isActivelyVisible: false,
        focusedAgentId: null,
        focusedTerminalId: null,
        target: { kind: "terminal", id: "t1" },
      }),
    ).toMatchObject({
      suppress: false,
      showOsBubble: false,
      showBanner: false,
      intrusiveFocusAndNavigate: true,
      playSound: true,
    });
  });

  it("sound-only when unfocused with bubble and intrusive off", () => {
    expect(
      planAttentionInterrupt({
        settings: {
          ...defaultSettings,
          attentionOsBubbleEnabled: false,
          attentionIntrusiveMode: false,
        },
        isActivelyVisible: false,
        focusedAgentId: null,
        focusedTerminalId: null,
        target: { kind: "agent", id: "a1" },
      }),
    ).toMatchObject({
      showOsBubble: false,
      intrusiveFocusAndNavigate: false,
      showBanner: false,
      playSound: true,
    });
  });

  it("honors sound off", () => {
    expect(
      planAttentionInterrupt({
        settings: { ...defaultSettings, attentionSoundEnabled: false },
        isActivelyVisible: false,
        focusedAgentId: null,
        focusedTerminalId: null,
        target: { kind: "agent", id: "a1" },
      }).playSound,
    ).toBe(false);
  });

  it("matches terminal focus target", () => {
    expect(
      planAttentionInterrupt({
        settings: defaultSettings,
        isActivelyVisible: true,
        focusedAgentId: null,
        focusedTerminalId: "t1",
        target: { kind: "terminal", id: "t1" },
      }).suppress,
    ).toBe(true);
  });
});
