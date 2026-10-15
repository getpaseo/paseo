import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createWorkspaceServiceRoutePreferencesStore } from "./store";

function createMemoryStorage(initial?: Record<string, string>): StateStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    values,
    getItem: async (name) => values.get(name) ?? null,
    setItem: async (name, value) => {
      values.set(name, value);
    },
    removeItem: async (name) => {
      values.delete(name);
    },
  };
}

describe("workspace service route preferences", () => {
  it("persists each host's preferred route", async () => {
    const storage = createMemoryStorage();
    const first = createWorkspaceServiceRoutePreferencesStore(storage);
    await first.persist.rehydrate();

    first.getState().setPreferredRoute("desktop", "direct");
    first.getState().setPreferredRoute("devbox", "public");

    const restored = createWorkspaceServiceRoutePreferencesStore(storage);
    await restored.persist.rehydrate();
    expect(restored.getState().byServerId).toEqual({ desktop: "direct", devbox: "public" });
  });

  it("clears the complete persisted value when one route kind is invalid", async () => {
    const storage = createMemoryStorage({
      "workspace-service-route-preferences": JSON.stringify({
        state: { byServerId: { desktop: "direct", broken: "unknown" } },
        version: 1,
      }),
    });
    const store = createWorkspaceServiceRoutePreferencesStore(storage);
    await store.persist.rehydrate();

    expect(store.getState().byServerId).toEqual({});
    expect(storage.values.has("workspace-service-route-preferences")).toBe(false);
  });

  it("persists the preferred preview script per workspace", async () => {
    const storage = createMemoryStorage();
    const first = createWorkspaceServiceRoutePreferencesStore(storage);
    await first.persist.rehydrate();

    first.getState().setPreferredScript("server-a:ws-1", "app");
    first.getState().setPreferredScript("server-a:ws-2", "daemon");
    first.getState().setPreferredScript("server-b:ws-1", "desktop");

    const restored = createWorkspaceServiceRoutePreferencesStore(storage);
    await restored.persist.rehydrate();
    expect(restored.getState().preferredScriptByWorkspace).toEqual({
      "server-a:ws-1": "app",
      "server-a:ws-2": "daemon",
      "server-b:ws-1": "desktop",
    });
  });

  it("accepts storage written before preview preferences existed", async () => {
    const storage = createMemoryStorage({
      "workspace-service-route-preferences": JSON.stringify({
        state: { byServerId: { desktop: "direct" } },
        version: 1,
      }),
    });
    const store = createWorkspaceServiceRoutePreferencesStore(storage);
    await store.persist.rehydrate();

    expect(store.getState().byServerId).toEqual({ desktop: "direct" });
    expect(store.getState().preferredScriptByWorkspace).toEqual({});
  });
});
