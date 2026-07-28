/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { useDesktopOpenTargets } from "./desktop-open-targets";

vi.mock("@/desktop/host", () => ({
  getDesktopHost: vi.fn().mockReturnValue({
    editor: {
      listTargets: vi.fn().mockResolvedValue([
        {
          id: "explorer",
          label: "Explorer",
          kind: "file-manager",
          icon: { kind: "symbol", name: "folder" },
        },
      ]),
      openTarget: vi.fn(),
    },
  }),
}));

describe("useDesktopOpenTargets hook - stale cache behavior", () => {
  it("does not leak stale cached targets when isLocalExecution is false", () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(
      ["desktop-open-targets"],
      [
        {
          id: "explorer",
          label: "Explorer",
          kind: "file-manager",
          icon: { kind: "symbol", name: "folder" },
        },
      ],
    );

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useDesktopOpenTargets({ isLocalExecution: false }), {
      wrapper,
    });

    expect(result.current.targets).toEqual([]);
    expect(result.current.isAvailable).toBe(false);
  });

  it("returns targets when isLocalExecution is true", () => {
    const queryClient = new QueryClient();

    queryClient.setQueryData(
      ["desktop-open-targets"],
      [
        {
          id: "explorer",
          label: "Explorer",
          kind: "file-manager",
          icon: { kind: "symbol", name: "folder" },
        },
      ],
    );

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useDesktopOpenTargets({ isLocalExecution: true }), {
      wrapper,
    });

    expect(result.current.targets).toEqual([
      {
        id: "explorer",
        label: "Explorer",
        kind: "file-manager",
        icon: { kind: "symbol", name: "folder" },
      },
    ]);
    expect(result.current.isAvailable).toBe(true);
  });
});
