/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCliInstall, useSkillsStatus } from "./use-install-status";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  show: vi.fn(),
  copied: vi.fn(),
}));

const desktopDaemon = vi.hoisted(() => ({
  getCliInstallStatus: vi.fn(),
  installCli: vi.fn(),
  getSkillsStatus: vi.fn(),
  installSkills: vi.fn(),
  updateSkills: vi.fn(),
  uninstallSkills: vi.fn(),
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

describe("useSkillsStatus", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("loads the current skills status", async () => {
    desktopDaemon.getSkillsStatus.mockResolvedValue({
      state: "up-to-date",
      ops: [],
    });

    const { result } = renderDesktopHook(() => useSkillsStatus());

    await waitFor(() => {
      expect(result.current.status).toEqual({ state: "up-to-date", ops: [] });
    });
    expect(result.current.isWorking).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("install transitions a not-installed status to up-to-date and reflects the response directly", async () => {
    desktopDaemon.getSkillsStatus.mockResolvedValue({
      state: "not-installed",
      ops: [{ kind: "add", name: "paseo" }],
    });
    desktopDaemon.installSkills.mockResolvedValue({ state: "up-to-date", ops: [] });

    const { result } = renderDesktopHook(() => useSkillsStatus());

    await waitFor(() => {
      expect(result.current.status?.state).toBe("not-installed");
    });

    await act(async () => {
      await result.current.install();
    });

    expect(desktopDaemon.installSkills).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(result.current.status).toEqual({ state: "up-to-date", ops: [] });
    });
  });

  it("update transitions drift to up-to-date", async () => {
    desktopDaemon.getSkillsStatus.mockResolvedValue({
      state: "drift",
      ops: [{ kind: "update", name: "paseo" }],
    });
    desktopDaemon.updateSkills.mockResolvedValue({ state: "up-to-date", ops: [] });

    const { result } = renderDesktopHook(() => useSkillsStatus());

    await waitFor(() => {
      expect(result.current.status?.state).toBe("drift");
    });

    await act(async () => {
      await result.current.update();
    });

    expect(desktopDaemon.updateSkills).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(result.current.status).toEqual({ state: "up-to-date", ops: [] });
    });
  });

  it("uninstall transitions up-to-date back to not-installed", async () => {
    desktopDaemon.getSkillsStatus.mockResolvedValue({ state: "up-to-date", ops: [] });
    desktopDaemon.uninstallSkills.mockResolvedValue({
      state: "not-installed",
      ops: [{ kind: "add", name: "paseo" }],
    });

    const { result } = renderDesktopHook(() => useSkillsStatus());

    await waitFor(() => {
      expect(result.current.status?.state).toBe("up-to-date");
    });

    await act(async () => {
      await result.current.uninstall();
    });

    expect(desktopDaemon.uninstallSkills).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(result.current.status).toEqual({
        state: "not-installed",
        ops: [{ kind: "add", name: "paseo" }],
      });
    });
  });

  it("isWorking flips while a mutation is in flight", async () => {
    desktopDaemon.getSkillsStatus.mockResolvedValue({
      state: "not-installed",
      ops: [{ kind: "add", name: "paseo" }],
    });

    let resolveInstall: ((value: unknown) => void) | null = null;
    desktopDaemon.installSkills.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );

    const { result } = renderDesktopHook(() => useSkillsStatus());

    await waitFor(() => {
      expect(result.current.status?.state).toBe("not-installed");
    });
    expect(result.current.isWorking).toBe(false);

    let installPromise: Promise<void> = Promise.resolve();
    act(() => {
      installPromise = result.current.install();
    });

    await waitFor(() => {
      expect(result.current.isWorking).toBe(true);
    });

    await act(async () => {
      resolveInstall?.({ state: "up-to-date", ops: [] });
      await installPromise;
    });

    await waitFor(() => {
      expect(result.current.isWorking).toBe(false);
    });
    expect(result.current.status).toEqual({ state: "up-to-date", ops: [] });
  });

  it("toasts and exposes errors when install fails", async () => {
    const error = new Error("Missing IPC handler");
    desktopDaemon.getSkillsStatus.mockResolvedValue({
      state: "not-installed",
      ops: [{ kind: "add", name: "paseo" }],
    });
    desktopDaemon.installSkills.mockRejectedValue(error);

    const { result } = renderDesktopHook(() => useSkillsStatus());

    await waitFor(() => {
      expect(result.current.status?.state).toBe("not-installed");
    });

    await act(async () => {
      await result.current.install();
    });

    await waitFor(() => {
      expect(result.current.error).toBe(error);
    });
    expect(toast.error).toHaveBeenCalledWith("Unable to install orchestration skills.");
    expect(console.error).toHaveBeenCalledWith("[Integrations] Failed to install skills", error);
  });
});
