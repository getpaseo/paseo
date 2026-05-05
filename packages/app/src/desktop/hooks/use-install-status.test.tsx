/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCliInstall, useSkillsInstall } from "./use-install-status";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  show: vi.fn(),
  copied: vi.fn(),
}));

const desktopDaemon = vi.hoisted(() => ({
  getCliInstallStatus: vi.fn(),
  getSkillsInstallStatus: vi.fn(),
  installCli: vi.fn(),
  installSkills: vi.fn(),
  shouldUseDesktopDaemon: vi.fn(() => true),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => toast,
}));

vi.mock("@/desktop/daemon/desktop-daemon", () => desktopDaemon);

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderDesktopHook<TResult>(callback: () => TResult) {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return renderHook(callback, { wrapper });
}

describe("useCliInstall", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    desktopDaemon.getCliInstallStatus.mockResolvedValue({ installed: true });
    desktopDaemon.installCli.mockResolvedValue({ installed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("loads CLI install status", async () => {
    const { result } = renderDesktopHook(() => useCliInstall());

    await waitFor(() => {
      expect(result.current.status).toEqual({ installed: true });
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts and exposes CLI install errors", async () => {
    const error = new Error("Missing IPC handler");
    desktopDaemon.getCliInstallStatus.mockResolvedValue({ installed: false });
    desktopDaemon.installCli.mockRejectedValue(error);
    const { result } = renderDesktopHook(() => useCliInstall());

    await waitFor(() => {
      expect(result.current.status).toEqual({ installed: false });
    });

    act(() => {
      result.current.install();
    });

    await waitFor(() => {
      expect(result.current.error).toBe(error);
    });

    expect(toast.error).toHaveBeenCalledWith("Unable to install the Paseo CLI.");
    expect(console.error).toHaveBeenCalledWith("[Integrations] Failed to install CLI", error);
  });
});

describe("useSkillsInstall", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    desktopDaemon.getSkillsInstallStatus.mockResolvedValue({ installed: true });
    desktopDaemon.installSkills.mockResolvedValue({ installed: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("loads skills install status", async () => {
    const { result } = renderDesktopHook(() => useSkillsInstall());

    await waitFor(() => {
      expect(result.current.status).toEqual({ installed: true });
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts and exposes skills install errors", async () => {
    const error = new Error("Missing IPC handler");
    desktopDaemon.getSkillsInstallStatus.mockResolvedValue({ installed: false });
    desktopDaemon.installSkills.mockRejectedValue(error);
    const { result } = renderDesktopHook(() => useSkillsInstall());

    await waitFor(() => {
      expect(result.current.status).toEqual({ installed: false });
    });

    act(() => {
      result.current.install();
    });

    await waitFor(() => {
      expect(result.current.error).toBe(error);
    });

    expect(toast.error).toHaveBeenCalledWith("Unable to install orchestration skills.");
    expect(console.error).toHaveBeenCalledWith("[Integrations] Failed to install skills", error);
  });
});
