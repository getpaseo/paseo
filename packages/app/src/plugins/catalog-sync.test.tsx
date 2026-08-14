/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const connection = vi.hoisted(() => ({ connected: true, supported: true }));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => connection.connected,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => connection.supported,
}));

import { PluginCatalogSync } from "./catalog-sync";
import { pluginRegistry } from "./registry";

function bundle(): string {
  return `(function() { return { default: function(plugin) {
    plugin.addSurface("main", function() { return null; });
    return function() { globalThis.__catalogSyncCleanups = (globalThis.__catalogSyncCleanups || 0) + 1; };
  } }; })`;
}

const unsubscribe = vi.fn();
const catalogClient = {
  getPluginCatalog: vi.fn(async () => [{ id: "example", clientBundle: bundle() }]),
  on: vi.fn(() => unsubscribe),
} as unknown as DaemonClient;

describe("PluginCatalogSync", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    connection.connected = true;
    connection.supported = true;
    unsubscribe.mockReset();
    vi.mocked(catalogClient.getPluginCatalog).mockClear();
    vi.mocked(catalogClient.on).mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    pluginRegistry.removeHost("host-a");
    container.remove();
    Reflect.deleteProperty(globalThis, "__catalogSyncCleanups");
    vi.unstubAllGlobals();
  });

  async function renderSync(): Promise<void> {
    await act(async () => {
      root.render(<PluginCatalogSync serverId="host-a" client={catalogClient} />);
      await Promise.resolve();
    });
  }

  it("tears down through disconnect and unmount boundaries exactly once each", async () => {
    await renderSync();
    const first = pluginRegistry.getSnapshot()[0];
    expect(first?.id).toBe("example");
    first?.queryClient.setQueryData(["owned"], "state");

    connection.connected = false;
    await renderSync();

    expect(Reflect.get(globalThis, "__catalogSyncCleanups")).toBe(1);
    expect(first?.queryClient.getQueryCache().getAll()).toEqual([]);
    expect(pluginRegistry.getSnapshot()).toEqual([]);

    connection.connected = true;
    await renderSync();
    expect(pluginRegistry.getSnapshot()).toHaveLength(1);

    act(() => root.unmount());
    root = createRoot(container);

    expect(Reflect.get(globalThis, "__catalogSyncCleanups")).toBe(2);
    expect(pluginRegistry.getSnapshot()).toEqual([]);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
