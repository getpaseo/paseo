import { describe, expect, it, vi } from "vitest";
import { type FetchedAgentResult, resolveForkAgentSource } from "@/hooks/resolve-fork-agent-source";
import type { ForkAgentSource } from "@/hooks/use-fork-agent";

function createForkAgentSource(overrides: Partial<ForkAgentSource> = {}): ForkAgentSource {
  return {
    provider: "codex",
    cwd: "/repo",
    currentModeId: null,
    model: null,
    thinkingOptionId: null,
    runtimeInfo: null,
    features: [],
    projectPlacement: null,
    ...overrides,
  } as ForkAgentSource;
}

function createFetchedResult(): FetchedAgentResult {
  return { agent: { id: "agent-1" } } as unknown as FetchedAgentResult;
}

describe("resolveForkAgentSource", () => {
  it("uses the store record without touching the daemon when it is present", async () => {
    const stored = createForkAgentSource({ cwd: "/repo/from-store" });
    const fetchAgent = vi.fn();
    const storeAgent = vi.fn();

    const resolution = await resolveForkAgentSource({
      agentId: "agent-1",
      readAgent: () => stored,
      fetchAgent,
      storeAgent,
    });

    expect(resolution).toEqual({ kind: "resolved", agent: stored });
    expect(fetchAgent).not.toHaveBeenCalled();
    expect(storeAgent).not.toHaveBeenCalled();
  });

  it("still resolves via the store when there is no connected client", async () => {
    const stored = createForkAgentSource({ cwd: "/repo/offline" });

    const resolution = await resolveForkAgentSource({
      agentId: "agent-1",
      readAgent: () => stored,
      fetchAgent: null,
      storeAgent: vi.fn(),
    });

    expect(resolution).toEqual({ kind: "resolved", agent: stored });
  });

  it("fetches, stores, and resolves with the stored record when the tab outlived its record", async () => {
    const fetched = createFetchedResult();
    // The record the store hydrates is what the fork must use — not the raw
    // fetch payload, which is an un-normalized wire snapshot.
    const hydrated = createForkAgentSource({ cwd: "/repo/hydrated", provider: "claude" });
    const fetchAgent = vi.fn(async () => fetched);
    const storeAgent = vi.fn(() => hydrated);

    const resolution = await resolveForkAgentSource({
      agentId: "agent-1",
      readAgent: () => undefined,
      fetchAgent,
      storeAgent,
    });

    expect(fetchAgent).toHaveBeenCalledWith("agent-1");
    expect(storeAgent).toHaveBeenCalledWith(fetched);
    expect(resolution).toEqual({ kind: "resolved", agent: hydrated });
    expect(resolution.kind === "resolved" && resolution.agent.cwd).toBe("/repo/hydrated");
    expect(resolution.kind === "resolved" && resolution.agent.provider).toBe("claude");
  });

  it("reads the store exactly once per resolve", async () => {
    const readAgent = vi.fn(() => undefined);

    await resolveForkAgentSource({
      agentId: "agent-1",
      readAgent,
      fetchAgent: async () => null,
      storeAgent: vi.fn(),
    });

    expect(readAgent).toHaveBeenCalledTimes(1);
  });

  it("reports not_found when the daemon has no such agent", async () => {
    const storeAgent = vi.fn();

    const resolution = await resolveForkAgentSource({
      agentId: "agent-1",
      readAgent: () => null,
      fetchAgent: async () => null,
      storeAgent,
    });

    expect(resolution).toEqual({ kind: "not_found" });
    expect(storeAgent).not.toHaveBeenCalled();
  });

  it("reports not_found when the fetch rejects with a not-found error", async () => {
    const resolution = await resolveForkAgentSource({
      agentId: "agent-1",
      readAgent: () => null,
      fetchAgent: async () => {
        throw new Error("Agent not found: agent-1");
      },
      storeAgent: vi.fn(),
    });

    expect(resolution).toEqual({ kind: "not_found" });
  });

  it("reports a transient error with its message when the fetch rejects otherwise", async () => {
    const resolution = await resolveForkAgentSource({
      agentId: "agent-1",
      readAgent: () => null,
      fetchAgent: async () => {
        throw new Error("socket hang up");
      },
      storeAgent: vi.fn(),
    });

    expect(resolution).toEqual({ kind: "error", message: "socket hang up" });
  });

  it("reports disconnected without fetching when the record is missing and no client is connected", async () => {
    const storeAgent = vi.fn();

    const resolution = await resolveForkAgentSource({
      agentId: "agent-1",
      readAgent: () => undefined,
      fetchAgent: null,
      storeAgent,
    });

    expect(resolution).toEqual({ kind: "disconnected" });
    expect(storeAgent).not.toHaveBeenCalled();
  });
});
