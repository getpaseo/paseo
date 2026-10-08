/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSkills } from "./use-agent-skills";

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  activeProfileId: undefined as string | undefined,
  clients: new Map<
    string,
    {
      getAgentSkillsStatus: ReturnType<typeof vi.fn>;
      saveAgentSkillsSelection?: ReturnType<typeof vi.fn>;
    }
  >(),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "skillManagement" && runtime.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => runtime.clients.get(serverId) ?? null,
  useHostRuntimeIsConnected: () => runtime.connected,
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: {
      agentSettingsProfiles: runtime.activeProfileId
        ? { activeProfileId: runtime.activeProfileId, profiles: [] }
        : undefined,
      skills: { selection: { mode: "all" } },
    },
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

describe("host agent skills", () => {
  beforeEach(() => {
    runtime.connected = true;
    runtime.supported = true;
    runtime.activeProfileId = undefined;
    runtime.clients.clear();
  });

  it("reads status from the selected host client", async () => {
    const local = { getAgentSkillsStatus: vi.fn() };
    const remote = {
      getAgentSkillsStatus: vi.fn(async () => ({
        state: "not-installed",
        ops: [],
        available: ["paseo"],
        installed: [],
        selection: { mode: "all" },
      })),
    };
    runtime.clients.set("local", local);
    runtime.clients.set("remote", remote);

    const { result } = renderHook(() => useAgentSkills("remote"), { wrapper });
    await waitFor(() => expect(result.current.status?.available).toEqual(["paseo"]));
    expect(remote.getAgentSkillsStatus).toHaveBeenCalledOnce();
    expect(local.getAgentSkillsStatus).not.toHaveBeenCalled();
  });

  it("does not call an old host without the capability", async () => {
    runtime.supported = false;
    const client = { getAgentSkillsStatus: vi.fn() };
    runtime.clients.set("old-host", client);

    const { result } = renderHook(() => useAgentSkills("old-host"), { wrapper });
    expect(result.current.supported).toBe(false);
    expect(client.getAgentSkillsStatus).not.toHaveBeenCalled();
  });

  it("reads and saves the settings profile captured before the host active profile changes", async () => {
    runtime.activeProfileId = "coding";
    const client = {
      getAgentSkillsStatus: vi.fn(async () => ({
        state: "up-to-date",
        ops: [],
        available: ["paseo"],
        installed: ["paseo"],
        selection: { mode: "custom" as const, skills: ["paseo"] },
      })),
      saveAgentSkillsSelection: vi.fn(async () => ({
        state: "up-to-date",
        ops: [],
        available: ["paseo"],
        installed: ["paseo"],
        selection: { mode: "custom" as const, skills: ["paseo"] },
        confirmationRequired: null,
      })),
    };
    runtime.clients.set("host", client);

    const { result } = renderHook(() => useAgentSkills("host"), { wrapper });
    await waitFor(() =>
      expect(result.current.status?.selection).toEqual({
        mode: "custom",
        skills: ["paseo"],
      }),
    );
    runtime.activeProfileId = "reverse";
    await result.current.saveSelection({ mode: "custom", skills: ["paseo"] });

    expect(client.getAgentSkillsStatus).toHaveBeenCalledWith("coding");
    expect(client.saveAgentSkillsSelection).toHaveBeenCalledWith(
      { mode: "custom", skills: ["paseo"] },
      { confirmedRemovals: [], profileId: "coding" },
    );
  });
});
