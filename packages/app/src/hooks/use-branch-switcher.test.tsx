/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useBranchSwitcher } from "./use-branch-switcher";

afterEach(cleanup);
function setup(getBranches: () => Promise<{ branches: string[]; error: string | null }>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const client = { getBranchSuggestions: getBranches } as unknown as DaemonClient;
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(
    () =>
      useBranchSwitcher({
        client,
        normalizedServerId: "host",
        normalizedWorkspaceId: "workspace",
        workspaceDirectory: "/repo",
        currentBranchName: "main",
        isGitCheckout: true,
        isConnected: true,
        queryClient,
        toast: {
          show() {
            return () => {};
          },
          error() {},
          copied() {},
        },
      }),
    { wrapper },
  );
}

describe("branch suggestions lifecycle", () => {
  it("distinguishes first-open loading with no search from successful empty results", async () => {
    let resolve!: (value: { branches: string[]; error: null }) => void;
    const response = new Promise<{ branches: string[]; error: null }>((done) => {
      resolve = done;
    });
    const { result } = setup(() => response);
    act(() => result.current.setIsOpen(true));
    expect(result.current.branchOptions).toEqual([]);
    expect(result.current.isLoadingBranches).toBe(true);
    expect(result.current.branchError).toBeNull();
    await act(async () => {
      resolve({ branches: [], error: null });
    });
    await waitFor(() => expect(result.current.isLoadingBranches).toBe(false));
    expect(result.current.branchOptions).toEqual([]);
  });
  it("exposes errors and retries without reopening, then keeps cached branches on reopening", async () => {
    let fail = true;
    const { result } = setup(async () =>
      fail
        ? { branches: [], error: "Git unavailable" }
        : { branches: ["main", "feature"], error: null },
    );
    act(() => result.current.setIsOpen(true));
    await waitFor(() => expect(result.current.branchError?.message).toBe("Git unavailable"));
    expect(result.current.isLoadingBranches).toBe(false);
    fail = false;
    act(() => result.current.retryBranches());
    await waitFor(() =>
      expect(result.current.branchOptions).toEqual([
        { id: "main", label: "main" },
        { id: "feature", label: "feature" },
      ]),
    );
    expect(result.current.branchError).toBeNull();
    act(() => result.current.setIsOpen(false));
    act(() => result.current.setIsOpen(true));
    expect(result.current.isLoadingBranches).toBe(false);
    expect(result.current.branchOptions).toHaveLength(2);
  });
});
