/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/resources/en";

// Native styling and live microphone telemetry are outside this rendered UI test.
vi.mock("react-native-unistyles", async () => {
  const { darkTheme } = await import("@/styles/theme");
  return {
    StyleSheet: { create: (factory: (theme: typeof darkTheme) => unknown) => factory(darkTheme) },
    withUnistyles: (component: unknown) => component,
  };
});
vi.mock("@/contexts/voice-context", () => ({
  useVoiceTelemetry: () => ({ volume: 0, isSpeaking: false }),
}));
vi.mock("./volume-meter", () => ({ VolumeMeter: () => null }));
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
import { RealtimeVoiceOverlay } from "./realtime-voice-overlay";

describe("voice microphone controls", () => {
  let root: Root;
  let container: HTMLDivElement;
  const i18n = createInstance();
  const onToggleMute = vi.fn();
  const onStop = vi.fn();
  const baseProps = {
    isMuted: true,
    isSwitching: false,
    voiceCommandsEnabled: true,
    isMuteSwitching: false,
    muteError: null,
    onToggleMute,
    onStop,
  };

  async function render(
    overrides: Partial<React.ComponentProps<typeof RealtimeVoiceOverlay>> = {},
  ) {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <RealtimeVoiceOverlay {...baseProps} {...overrides} />
        </I18nextProvider>,
      );
    });
  }

  beforeEach(async () => {
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the persistent mute state and explains how verbal unmute still works", async () => {
    await render();
    expect(container.textContent).toContain("Microphone muted to agent");
    expect(container.textContent).toContain("Listening on your host only for “unmute microphone”");
    expect(container.textContent).toContain("Other speech is discarded");
    const unmute = container.querySelector<HTMLElement>('[aria-label="Unmute realtime voice"]')!;
    await act(async () => unmute.click());
    expect(onToggleMute).toHaveBeenCalledOnce();
    await render({ isMuted: false });
    expect(container.textContent).toContain("Microphone on");
    expect(container.textContent).toContain("Say “mute microphone” on its own");
  });

  it("shows a failed acknowledgement and keeps stop voice available", async () => {
    await render({ muteError: "Microphone paused. Stop and restart voice to reconnect." });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Microphone paused. Stop and restart voice to reconnect.",
    );
    const stop = container.querySelector<HTMLElement>('[aria-label="Stop realtime voice"]')!;
    await act(async () => stop.click());
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("prevents duplicate tap requests while a mute change is pending", async () => {
    await render({ isMuteSwitching: true });
    const unmute = container.querySelector<HTMLElement>('[aria-label="Unmute realtime voice"]')!;
    expect(unmute.getAttribute("aria-disabled")).toBe("true");
    await act(async () => unmute.click());
    expect(onToggleMute).not.toHaveBeenCalled();
  });
});
