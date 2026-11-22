import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAddHostFlow } from "@/hosts/add-host/internal/model";
import type { AddHostOptions } from "@/hosts/add-host/internal/model";
import { WorkspaceNavigationListener } from "./workspace-navigation.electron";

const runtime = vi.hoisted(() => ({
  connected: false,
  navigate: vi.fn(),
  session: {
    hasLiveWorkspaceDirectory: false,
    workspaces: new Map([["workspace-1", { id: "workspace-1", workspaceDirectory: "/checkout" }]]),
  },
}));
const flow = createAddHostFlow();
vi.mock("@/hosts/add-host", () => ({
  useAddHost: (options: AddHostOptions) => () => flow.open(options),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "srv_saved" }],
  useHostRegistryLoaded: () => true,
  useHostRuntimeIsConnected: () => runtime.connected,
}));
vi.mock("@/stores/session-store", () => {
  const state = { sessions: { srv_saved: runtime.session } };
  return {
    useSessionStore: Object.assign((select: (state: unknown) => unknown) => select(state), {
      getState: () => state,
    }),
  };
});
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: runtime.navigate,
}));
vi.mock("@/hooks/use-directory-demand", () => ({ useDirectoryDemand: () => {} }));
vi.mock("@/hooks/use-open-project", () => ({ useOpenProject: () => vi.fn() }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: vi.fn() }) }));

const target = { serverId: "srv_saved", path: "/checkout" };
const listeners = new Map<string, (payload: unknown) => void>();
const ready = vi.fn(async () => {});
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  runtime.connected = false;
  runtime.session.hasLiveWorkspaceDirectory = false;
  runtime.navigate.mockReset();
  ready.mockReset();
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("paseoDesktop", {
    events: {
      on: (event: string, handler: (payload: unknown) => void) => {
        listeners.set(event, handler);
        return Promise.resolve(() => listeners.delete(event));
      },
    },
    workspaceNavigation: { ready },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  flow.store.getState().session?.close();
  container.remove();
  vi.unstubAllGlobals();
});

async function renderListener() {
  await act(async () => root.render(<WorkspaceNavigationListener />));
}

it("keeps a newer agent link selected when the old workspace's host comes online", async () => {
  await renderListener();
  await act(async () => listeners.get("open-workspace")!(target));
  expect(runtime.navigate).not.toHaveBeenCalled();

  await act(async () => listeners.get("open-workspace")!(null));
  runtime.connected = true;
  runtime.session.hasLiveWorkspaceDirectory = true;
  await renderListener();

  expect(runtime.navigate).not.toHaveBeenCalled();
  await act(async () => listeners.get("open-workspace")!(target));
  expect(runtime.navigate).toHaveBeenCalledExactlyOnceWith({
    serverId: target.serverId,
    workspaceId: "workspace-1",
  });
});

it("opens a newer queued workspace after a startup cancellation", async () => {
  runtime.connected = true;
  runtime.session.hasLiveWorkspaceDirectory = true;
  ready.mockImplementationOnce(async () => {
    const deliver = listeners.get("open-workspace")!;
    deliver(null);
    deliver(target);
  });

  await renderListener();

  expect(runtime.navigate).toHaveBeenCalledExactlyOnceWith({
    serverId: target.serverId,
    workspaceId: "workspace-1",
  });
});

it("closes the superseded SSH request when a newer link names a saved host", async () => {
  await renderListener();
  await act(async () => listeners.get("open-workspace")!({ ...target, serverId: "srv_unknown" }));
  expect(flow.store.getState().session?.step.getState().method).toBe("ssh");

  runtime.connected = true;
  runtime.session.hasLiveWorkspaceDirectory = true;
  await act(async () => listeners.get("open-workspace")!(target));

  expect(flow.store.getState().session).toBeNull();
  expect(runtime.navigate).toHaveBeenCalledExactlyOnceWith({
    serverId: target.serverId,
    workspaceId: "workspace-1",
  });
});
