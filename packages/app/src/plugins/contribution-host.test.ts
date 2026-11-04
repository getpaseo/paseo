import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createPluginHostPreferences } from "./contribution-host";

describe("plugin host preferences", () => {
  it("restores the last choice in a fresh store", async () => {
    const values = new Map<string, string>();
    const storage: StateStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const first = createPluginHostPreferences(storage);
    await first.persist.rehydrate();
    first.setState({ hosts: { "firstmate/screens": "mac", "cafe/screens": "linux" } });
    const next = createPluginHostPreferences(storage);
    await next.persist.rehydrate();
    expect(next.getState().hosts).toEqual({ "firstmate/screens": "mac", "cafe/screens": "linux" });
  });

  it("keeps a choice made before asynchronous hydration completes", async () => {
    let release!: (value: string) => void;
    let written: string | null = null;
    const storage: StateStorage = {
      getItem: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      setItem: (_key, value) => {
        written = value;
      },
      removeItem: () => undefined,
    };
    const store = createPluginHostPreferences(storage);
    const hydrated = new Promise<void>((resolve) => {
      store.persist.onFinishHydration(() => resolve());
    });
    store.setState({ hosts: { "firstmate/screens": "mac" } });
    release(
      JSON.stringify({
        state: { hosts: { "firstmate/screens": "linux", "cafe/screens": "linux" } },
        version: 0,
      }),
    );
    await hydrated;
    expect(store.getState().hosts).toEqual({ "firstmate/screens": "mac", "cafe/screens": "linux" });
    expect(JSON.parse(written!).state.hosts["firstmate/screens"]).toBe("mac");
  });

  it("ignores malformed saved preferences", async () => {
    const store = createPluginHostPreferences({
      getItem: () => "broken json",
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    await store.persist.rehydrate();
    expect(store.getState().hosts).toEqual({});
  });
});
