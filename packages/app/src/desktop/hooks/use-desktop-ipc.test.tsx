/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopMutation, useDesktopQuery } from "./use-desktop-ipc";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  show: vi.fn(),
  copied: vi.fn(),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => toast,
}));

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

describe("useDesktopMutation", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("returns data from a successful desktop command", async () => {
    const mutationFn = vi.fn(async () => ({ installed: true }));
    const { result } = renderDesktopHook(() =>
      useDesktopMutation({
        mutationFn,
        errorMessage: "Install failed",
        logLabel: "[Desktop] Install failed",
      }),
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).resolves.toEqual({ installed: true });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ installed: true });
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts and exposes errors from a failed desktop command", async () => {
    const error = new Error("Missing IPC handler");
    const mutationFn = vi.fn(async () => {
      throw error;
    });
    const { result } = renderDesktopHook(() =>
      useDesktopMutation({
        mutationFn,
        errorMessage: "Install failed",
        logLabel: "[Desktop] Install failed",
      }),
    );

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("Missing IPC handler");
    });

    await waitFor(() => {
      expect(result.current.error).toBe(error);
    });
    expect(toast.error).toHaveBeenCalledWith("Install failed");
    expect(console.error).toHaveBeenCalledWith("[Desktop] Install failed", error);
  });
});

describe("useDesktopQuery", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("returns data from a successful desktop command", async () => {
    const queryFn = vi.fn(async () => ({ installed: true }));
    const { result } = renderDesktopHook(() =>
      useDesktopQuery({
        queryKey: ["desktop-ipc-test"],
        queryFn,
        errorMessage: "Status failed",
        logLabel: "[Desktop] Status failed",
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ installed: true });
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts and exposes errors from a failed desktop command", async () => {
    const error = new Error("Missing IPC handler");
    const queryFn = vi.fn(async () => {
      throw error;
    });
    const { result } = renderDesktopHook(() =>
      useDesktopQuery({
        queryKey: ["desktop-ipc-test-error"],
        queryFn,
        errorMessage: "Status failed",
        logLabel: "[Desktop] Status failed",
      }),
    );

    await waitFor(() => {
      expect(result.current.error).toBe(error);
    });

    expect(toast.error).toHaveBeenCalledWith("Status failed");
    expect(console.error).toHaveBeenCalledWith("[Desktop] Status failed", error);
  });
});
