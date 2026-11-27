// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useWorkspacePortForwardLifetime } from "./workspace-port-forward";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeSnapshot: () => ({ connectionStatus: "online", activeConnectionId: "direct" }),
}));
vi.mock("@/constants/platform", () => ({ getIsElectron: () => true }));
vi.mock("@/desktop/browser/proxy", () => ({}));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ browser: { workspacePortForward: invoke } }),
}));

it("prunes a removed workspace without pruning an initially unloaded descriptor", () => {
  invoke.mockResolvedValue(null);
  const { rerender } = renderHook(
    ({ loaded }) =>
      useWorkspacePortForwardLifetime("host", "workspace", loaded ? { scripts: [] } : null, true),
    { initialProps: { loaded: false } },
  );
  expect(invoke).not.toHaveBeenCalled();

  rerender({ loaded: true });
  invoke.mockClear();
  rerender({ loaded: false });
  expect(invoke).toHaveBeenCalledExactlyOnceWith({
    action: "prune",
    serverId: "host",
    workspaceId: "workspace",
    endpoints: [],
  });
  rerender({ loaded: false });
  expect(invoke).toHaveBeenCalledTimes(1);
});
