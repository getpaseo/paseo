/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDaemonConfig = vi.fn();
const patchDaemonConfig = vi.fn();
const refreshSnapshot = vi.fn();

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ getDaemonConfig, patchDaemonConfig }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        host: {
          serverInfo: {
            features: { modelVisibility: true },
            permissions: ["daemon.read"],
          },
        },
      },
    }),
}));

const CLAUDE_ENTRY = {
  provider: "claude",
  status: "ready",
  enabled: true,
  label: "Claude Code",
  defaultModeId: "plan",
  modes: [{ id: "plan", label: "Plan" }],
  models: [
    { provider: "claude", id: "claude-opus-5", label: "Opus 5", isDefault: true },
    { provider: "claude", id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
};

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [CLAUDE_ENTRY], refresh: refreshSnapshot }),
}));

vi.mock("@/data/query", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useReplicaQuery: (options: Record<string, unknown>) =>
      useQuery({ ...options, retry: false } as never),
  };
});

import { useAgentProfileFormCatalog } from "./use-profile-form-inputs";
import { openAgentProfileForm } from "./profile-form-model";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getDaemonConfig.mockReset();
  patchDaemonConfig.mockReset();
  refreshSnapshot.mockReset();
});

describe("agent profile catalog visibility retry (R5)", () => {
  it("exposes a retry that refetches the daemon config, not only discovery", async () => {
    getDaemonConfig.mockRejectedValueOnce(new Error("offline"));
    const model = openAgentProfileForm({ mode: "create" });

    const { result } = renderHook(() => useAgentProfileFormCatalog({ serverId: "host", model }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.modelVisibilityStatus).toBe("error"));
    expect(getDaemonConfig).toHaveBeenCalledTimes(1);

    getDaemonConfig.mockResolvedValueOnce({ config: { providers: {} } });
    act(() => {
      result.current.retryModelVisibility();
      result.current.refreshProviderCatalog();
    });

    // Both halves reached: the config is refetched and discovery is refreshed.
    await waitFor(() => expect(getDaemonConfig).toHaveBeenCalledTimes(2));
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.modelVisibilityStatus).toBe("ready"));
    model.close();
  });

  it("drives the model field into a recoverable error state", async () => {
    getDaemonConfig.mockRejectedValue(new Error("offline"));
    const model = openAgentProfileForm({ mode: "create" });

    const { result } = renderHook(() => useAgentProfileFormCatalog({ serverId: "host", model }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.modelVisibilityStatus).toBe("error"));
    model.setProvider("claude", { label: "Claude Code" });

    // The controller is what the modal renders from, so the error has to land
    // here, and no model may be seeded from the unfiltered catalog meanwhile.
    await waitFor(() => expect(model.getState().modelOptionsState).toBe("error"));
    expect(model.getState().modelOptions).toEqual([]);
    expect(model.getState().modelId).toBe("");
    expect(model.getState().canSubmit).toBe(false);
    model.close();
  });
});
