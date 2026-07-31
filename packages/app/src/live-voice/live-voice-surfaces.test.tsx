// @vitest-environment jsdom

import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveVoicePhase } from "@/live-voice/live-voice-runtime";

const { liveVoice } = vi.hoisted(() => ({
  liveVoice: {
    phase: "idle" as LiveVoicePhase,
    serverId: "host-a" as string | null,
    liveSessionId: null as string | null,
    sessionMode: "background" as "background" | "foreground" | null,
    isMuted: false,
    isAudioBlocked: false,
    transcripts: [] as Array<{ id: string; role: "user" | "assistant"; text: string }>,
    error: null as { code: string; message: string | null } | null,
    closedCause: null as string | null,
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    toggleMute: vi.fn(),
    resumeAudio: vi.fn(async () => {}),
    dismiss: vi.fn(),
    isActiveForServer: vi.fn(() => false),
  },
}));

vi.mock("@/contexts/live-voice-context", () => ({
  useLiveVoiceOptional: () => liveVoice,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "host-a", label: "Host A" }],
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("lucide-react-native", () => {
  const Icon = () => null;
  return {
    ChevronDown: Icon,
    ChevronUp: Icon,
    Mic: Icon,
    MicOff: Icon,
    PhoneOff: Icon,
    Volume2: Icon,
  };
});

import { SidebarLiveVoiceSlot } from "@/live-voice/live-voice-sidebar-card";
import { LiveVoiceStrip } from "@/live-voice/live-voice-strip";

function LiveVoiceSurfaces({ sidebarActive }: { sidebarActive: boolean }) {
  return (
    <>
      <SidebarLiveVoiceSlot active={sidebarActive} />
      <LiveVoiceStrip />
    </>
  );
}

function setPhase(phase: LiveVoicePhase, closedCause: string | null = null): void {
  liveVoice.phase = phase;
  liveVoice.closedCause = closedCause;
  liveVoice.error = phase === "error" ? { code: "webrtc_failed", message: null } : null;
}

describe("Live Voice call surfaces", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setPhase("idle");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  function renderSurfaces(sidebarActive: boolean): void {
    flushSync(() => root.render(<LiveVoiceSurfaces sidebarActive={sidebarActive} />));
  }

  function querySurface(testID: string): Element | null {
    return container.querySelector(`[data-testid="${testID}"]`);
  }

  it.each<LiveVoicePhase>(["starting", "active", "stopping"])(
    "shows the docked strip while %s without a visible sidebar",
    (phase) => {
      setPhase(phase);
      renderSurfaces(false);

      expect(querySurface("live-voice-strip")).not.toBeNull();
      expect(querySurface("live-voice-sidebar-card")).toBeNull();
    },
  );

  it("gives a visible sidebar exclusive ownership of the in-call surface", () => {
    setPhase("active");
    renderSurfaces(true);

    expect(querySurface("live-voice-sidebar-card")).not.toBeNull();
    expect(querySurface("live-voice-strip")).toBeNull();

    renderSurfaces(false);

    expect(querySurface("live-voice-sidebar-card")).toBeNull();
    expect(querySurface("live-voice-strip")).not.toBeNull();
  });

  it.each([
    { phase: "idle" as const, closedCause: null },
    { phase: "idle" as const, closedCause: "codex_closed" },
    { phase: "error" as const, closedCause: null },
  ])(
    "hides both large surfaces for terminal state $phase/$closedCause",
    ({ phase, closedCause }) => {
      setPhase(phase, closedCause);
      renderSurfaces(true);

      expect(querySurface("live-voice-sidebar-card")).toBeNull();
      expect(querySurface("live-voice-strip")).toBeNull();
    },
  );
});
