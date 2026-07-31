// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HostRuntimeConnectionStatus } from "./host-runtime";
import { useHostRuntimeConnectionStatusesFromStore } from "./host-runtime";

class ConnectionStatusStore {
  private listeners = new Set<() => void>();
  private statuses = new Map<string, HostRuntimeConnectionStatus>();

  subscribeAll(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(serverId: string): { connectionStatus: HostRuntimeConnectionStatus } | null {
    const connectionStatus = this.statuses.get(serverId);
    return connectionStatus ? { connectionStatus } : null;
  }

  setStatus(serverId: string, connectionStatus: HostRuntimeConnectionStatus): void {
    this.statuses.set(serverId, connectionStatus);
    for (const listener of this.listeners) listener();
  }
}

describe("useHostRuntimeConnectionStatusesFromStore", () => {
  it("publishes a host transition without changing the host list", () => {
    const store = new ConnectionStatusStore();
    store.setStatus("host-a", "connecting");

    const { result } = renderHook(() =>
      useHostRuntimeConnectionStatusesFromStore(store, ["host-a"]),
    );

    expect(result.current.get("host-a")).toBe("connecting");

    act(() => {
      store.setStatus("host-a", "online");
    });

    expect(result.current.get("host-a")).toBe("online");
  });
});
