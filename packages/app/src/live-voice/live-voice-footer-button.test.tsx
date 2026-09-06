// @vitest-environment jsdom

import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveVoicePhase } from "@/live-voice/live-voice-runtime";

const { closeMenu, liveVoice } = vi.hoisted(() => ({
  closeMenu: vi.fn(),
  liveVoice: {
    phase: "idle" as LiveVoicePhase,
    serverId: null as string | null,
    liveSessionId: null as string | null,
    isMuted: false,
    isAudioBlocked: false,
    transcripts: [],
    error: null as { code: string; message: string | null } | null,
    closedCause: null as string | null,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setMuted: vi.fn(),
    toggleMute: vi.fn(),
    resumeAudio: vi.fn(async () => {}),
    dismiss: vi.fn(),
    isActiveForServer: vi.fn(() => false),
  },
}));

vi.mock("@/assistants/assistant-queries", () => ({ useAssistants: () => ({ assistants: [] }) }));
vi.mock("@/assistants/assistants-sheet", () => ({ AssistantsSheet: () => null }));

vi.mock("@/contexts/live-voice-context", () => ({
  useLiveVoiceOptional: () => liveVoice,
}));

vi.mock("@/live-voice/live-voice-availability", () => ({
  useLiveVoiceAvailability: () => ({
    kind: "available",
    hosts: [
      {
        serverId: "host-a",
        label: "Host A",
        connectionStatus: "online",
        version: "0.2.7",
        supportsLiveVoice: true,
        supportsVoiceCatalog: true,
        paseoToolsEnabled: true,
      },
    ],
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.actions.retry": "Retry",
        "liveVoice.actions.dismiss": "Dismiss",
        "liveVoice.actions.start": "Start live voice",
        "liveVoice.errors.micUnavailable":
          "No usable microphone was found. Connect or select one in your device's audio settings, then retry.",
        "liveVoice.label": "Live voice",
        "liveVoice.status.error": "Failed",
      })[key] ?? key,
  }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuHint: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    closeOnSelect,
    description,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    closeOnSelect?: boolean;
    description?: string;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button
      type="button"
      data-testid={testID}
      data-close-on-select={String(closeOnSelect ?? true)}
      onClick={onSelect}
    >
      {children}
      {description}
    </button>
  ),
  DropdownMenuLabel: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuSeparator: () => <div role="separator" />,
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children: React.ReactNode | ((state: { hovered: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
      {typeof children === "function" ? children({ hovered: false }) : children}
    </button>
  ),
  useDropdownMenuClose: () => closeMenu,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("lucide-react-native", () => {
  const Icon = () => null;
  return {
    AudioLines: Icon,
    ChevronDown: Icon,
    ChevronUp: Icon,
    Mic: Icon,
    MicOff: Icon,
    PhoneOff: Icon,
    Volume2: Icon,
  };
});

import { LiveVoiceFooterButton } from "@/live-voice/live-voice-footer-button";

describe("LiveVoiceFooterButton", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    liveVoice.phase = "idle";
    liveVoice.serverId = null;
    liveVoice.error = null;
    liveVoice.closedCause = null;
    liveVoice.start.mockReset();
    liveVoice.start.mockResolvedValue(undefined);
    closeMenu.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(): void {
    act(() => root.render(<LiveVoiceFooterButton />));
  }

  function query(testID: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    expect(element).not.toBeNull();
    return element as HTMLElement;
  }

  it("keeps the launcher open until starting succeeds", async () => {
    let finishStart: () => void = () => {};
    liveVoice.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    render();

    const start = query("live-voice-menu-start");
    expect(start.dataset.closeOnSelect).toBe("false");
    fireEvent.click(start);

    await vi.waitFor(() => {
      expect(liveVoice.start).toHaveBeenCalledWith("host-a");
    });
    expect(closeMenu).not.toHaveBeenCalled();

    act(() => finishStart());
    await vi.waitFor(() => {
      expect(closeMenu).toHaveBeenCalledOnce();
    });
  });

  it("explains an unavailable microphone and retries on the same host", async () => {
    liveVoice.phase = "error";
    liveVoice.serverId = "host-a";
    liveVoice.error = { code: "mic_unavailable", message: null };
    render();

    const retry = query("live-voice-menu-retry");
    expect(retry.textContent).toContain("No usable microphone was found.");
    expect(retry.textContent).toContain("device's audio settings");
    expect(retry.dataset.closeOnSelect).toBe("false");

    fireEvent.click(retry);

    await vi.waitFor(() => {
      expect(liveVoice.start).toHaveBeenCalledWith("host-a");
      expect(closeMenu).toHaveBeenCalledOnce();
    });
  });
});
