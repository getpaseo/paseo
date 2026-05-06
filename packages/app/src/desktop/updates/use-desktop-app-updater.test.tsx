/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopAppUpdater } from "./use-desktop-app-updater";

const desktopUpdatesMock = vi.hoisted(() => ({
  shouldShowDesktopUpdateSection: vi.fn(() => true),
  checkDesktopAppUpdate: vi.fn(async () => ({
    hasUpdate: false,
    readyToInstall: false,
    latestVersion: null,
  })),
  installDesktopAppUpdate: vi.fn(async () => ({
    installed: false,
    message: null,
  })),
  formatVersionWithPrefix: vi.fn((version: string | null) => version ?? "\u2014"),
}));

const settingsState = vi.hoisted(() => ({
  releaseChannel: "stable" as "stable" | "beta",
}));

vi.mock("@/desktop/updates/desktop-updates", () => desktopUpdatesMock);

vi.mock("@/desktop/settings/desktop-settings", () => ({
  useDesktopSettings: () => ({
    settings: {
      releaseChannel: settingsState.releaseChannel,
      daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
    },
    isLoading: false,
    error: null,
    updateSettings: vi.fn(async () => {}),
  }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn(), show: vi.fn(), copied: vi.fn() }),
}));

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderUpdaterHook() {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return renderHook(() => useDesktopAppUpdater(), { wrapper });
}

describe("useDesktopAppUpdater", () => {
  beforeEach(() => {
    settingsState.releaseChannel = "stable";
    desktopUpdatesMock.checkDesktopAppUpdate.mockClear();
    desktopUpdatesMock.installDesktopAppUpdate.mockClear();
  });

  it("uses the effective desktop release channel when checking for updates", async () => {
    settingsState.releaseChannel = "beta";

    renderUpdaterHook();

    await waitFor(() => {
      expect(desktopUpdatesMock.checkDesktopAppUpdate).toHaveBeenCalledWith({
        releaseChannel: "beta",
      });
    });
  });

  it("uses the effective desktop release channel when installing updates", async () => {
    settingsState.releaseChannel = "beta";
    const { result } = renderUpdaterHook();

    await act(async () => {
      await result.current.installUpdate();
    });

    expect(desktopUpdatesMock.installDesktopAppUpdate).toHaveBeenCalledWith({
      releaseChannel: "beta",
    });
  });
});
