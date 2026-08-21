import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentMcpServers } from "./use-agent-mcp-servers";
import type { AgentMcpServersView } from "./types";

const listMcpServers = vi.fn();
const isConnected = { value: true };
const capability = { supportsMcpStatus: true };

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ listMcpServers }),
  useHostRuntimeIsConnected: () => isConnected.value,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        // Any agent id resolves, so switching agents exercises the query key rather
        // than falling out of the capability gate.
        host: { agents: { get: () => ({ capabilities: capability }) } },
      },
    }),
}));

vi.mock("@/i18n/i18next", () => ({
  i18n: { t: (key: string) => key },
}));

type View = AgentMcpServersView;

// The hook owns the rules this feature was rebuilt around — never retry an expensive
// fetch, one request per refresh, a permanent verdict may be cached but a transient one
// may not — and none of them are observable from the presentational panel.

beforeEach(() => {
  vi.stubGlobal("React", React);
  listMcpServers.mockReset();
  isConnected.value = true;
  capability.supportsMcpStatus = true;
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

interface Harness {
  view: () => View;
  refresh: () => Promise<void>;
  rerender: (props: { agentId?: string; enabled?: boolean }) => void;
}

function renderHook(initial: { agentId?: string; enabled?: boolean } = {}): Harness {
  let latest: ReturnType<typeof useAgentMcpServers> | null = null;
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });

  function Probe({ agentId = "agent-1", enabled = true }: { agentId?: string; enabled?: boolean }) {
    latest = useAgentMcpServers("host", agentId, { enabled });
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (props: { agentId?: string; enabled?: boolean }): void => {
    act(() => {
      root.render(
        (
          <QueryClientProvider client={client}>
            <Probe {...props} />
          </QueryClientProvider>
        ) as ReactNode,
      );
    });
  };
  render(initial);
  mounted.push({ root, container });

  return {
    view: () => {
      if (!latest) throw new Error("hook did not render");
      return latest.view;
    },
    refresh: async () => {
      if (!latest) throw new Error("hook did not render");
      const run = latest.refresh();
      await act(async () => {
        await run;
      });
    },
    rerender: render,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function ok(servers: Array<{ name: string; status: string }>, source = "live") {
  return { agentId: "agent-1", servers, source, fetchedAt: "", error: null, requestId: "r" };
}

describe("useAgentMcpServers", () => {
  it("asks for nothing while the panel is closed", async () => {
    renderHook({ enabled: false });
    await settle();

    expect(listMcpServers).not.toHaveBeenCalled();
  });

  it("does not retry a failed fetch", async () => {
    listMcpServers.mockRejectedValue(new Error("boom"));
    const harness = renderHook();
    await settle();

    // React Query's default is three retries. Against Codex that is four calls of
    // 1.1MB and ~3.5s each for one failure.
    expect(listMcpServers).toHaveBeenCalledTimes(1);
    expect(harness.view().kind).toBe("error");
  });

  it("treats an unsupported provider as a terminal verdict", async () => {
    listMcpServers.mockResolvedValue({ ...ok([]), unavailable: "unsupported" });
    const harness = renderHook();
    await settle();

    expect(harness.view().kind).toBe("unsupported");
  });

  it("treats a stopped agent as a retryable error, not a verdict", async () => {
    listMcpServers.mockResolvedValue({ ...ok([]), unavailable: "agent_not_running" });
    const harness = renderHook();
    await settle();

    // Caching this as `unsupported` would remove the control — and its refresh — for
    // the rest of the session, even after the agent starts again.
    const view = harness.view();
    expect(view.kind).toBe("error");

    listMcpServers.mockResolvedValue(ok([{ name: "paseo", status: "connected" }]));
    await harness.refresh();
    expect(harness.view().kind).toBe("ready");
  });

  it("makes exactly one request per refresh, and forces past the caches", async () => {
    listMcpServers.mockResolvedValue(ok([{ name: "paseo", status: "connected" }]));
    const harness = renderHook();
    await settle();
    expect(listMcpServers).toHaveBeenCalledTimes(1);

    await harness.refresh();

    expect(listMcpServers).toHaveBeenCalledTimes(2);
    expect(listMcpServers).toHaveBeenLastCalledWith("agent-1", { force: true });
  });

  it("surfaces a failed refresh instead of leaving the stale rows looking current", async () => {
    listMcpServers.mockResolvedValue(ok([{ name: "paseo", status: "connected" }]));
    const harness = renderHook();
    await settle();
    expect(harness.view().kind).toBe("ready");

    listMcpServers.mockRejectedValue(new Error("host went away"));
    await harness.refresh();

    // A refetch over retained data leaves the query successful, so without explicit
    // handling this failure would be completely invisible.
    const view = harness.view();
    expect(view.kind).toBe("error");
    expect(view.kind === "error" && view.message).toContain("host went away");
  });

  it("does not show one agent's servers under another agent's name", async () => {
    listMcpServers.mockResolvedValue(ok([{ name: "first-agent-server", status: "connected" }]));
    const harness = renderHook();
    await settle();
    expect(harness.view().kind).toBe("ready");

    const gate: { release: () => void } = { release: () => {} };
    listMcpServers.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve(ok([{ name: "second-agent-server", status: "connected" }]));
        }),
    );
    harness.rerender({ agentId: "agent-2" });
    await settle();

    // `keepPreviousData` would hold the previous agent's rows here for the whole fetch.
    expect(harness.view().kind).toBe("loading");
    gate.release();
    await settle();
    const view = harness.view();
    expect(view.kind === "ready" && view.servers[0]?.name).toBe("second-agent-server");
  });

  it("carries the report's source through to the view", async () => {
    listMcpServers.mockResolvedValue(ok([{ name: "paseo", status: "unknown" }], "configured"));
    const harness = renderHook();
    await settle();

    const view = harness.view();
    expect(view.kind === "ready" && view.source).toBe("configured");
  });

  it("never asks when the agent's capabilities rule it out", async () => {
    capability.supportsMcpStatus = false;
    const harness = renderHook();
    await settle();

    expect(listMcpServers).not.toHaveBeenCalled();
    expect(harness.view().kind).toBe("unsupported");
  });
});
