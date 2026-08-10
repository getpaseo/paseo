import { describe, expect, it } from "vitest";
import type { ShortcutOverrides } from "@/keyboard/keyboard-shortcuts";
import {
  createShortcutOverrideStore,
  type ShortcutOverrideStore,
} from "@/keyboard/shortcut-override-store";

interface Harness {
  store: ShortcutOverrideStore;
  /** What the UI would render. */
  cached(): ShortcutOverrides;
  /** What a relaunch would load. */
  persisted(): ShortcutOverrides | null;
  errors: unknown[];
  /** Cache and storage transitions in the order they happened. */
  events: string[];
}

/**
 * @param failWrites 1-based indexes of `storage.write` calls that reject.
 */
function createHarness(
  options: { seed?: ShortcutOverrides; failWrites?: number[]; failRemove?: boolean } = {},
): Harness {
  const failWrites = new Set(options.failWrites ?? []);
  let cache: ShortcutOverrides = options.seed ?? {};
  let stored: string | null = options.seed ? JSON.stringify(options.seed) : null;
  let writeCount = 0;
  const errors: unknown[] = [];
  const events: string[] = [];

  const store = createShortcutOverrideStore({
    cache: {
      read: () => cache,
      write: (next) => {
        cache = next;
        events.push(`cache ${JSON.stringify(next)}`);
      },
    },
    storage: {
      write: async (serialized) => {
        writeCount += 1;
        const failed = failWrites.has(writeCount);
        await settle(1);
        if (failed) {
          events.push(`write-failed ${serialized}`);
          throw new Error("storage unavailable");
        }
        stored = serialized;
        events.push(`write ${serialized}`);
      },
      // Slower than a write, so an unserialized reset would land last and
      // delete whatever was written after it.
      remove: async () => {
        await settle(3);
        if (options.failRemove) {
          events.push("remove-failed");
          throw new Error("storage unavailable");
        }
        stored = null;
        events.push("remove");
      },
    },
    onError: (err) => errors.push(err),
  });

  return {
    store,
    cached: () => cache,
    persisted: () => (stored === null ? null : (JSON.parse(stored) as ShortcutOverrides)),
    errors,
    events,
  };
}

/** Deterministic stand-in for storage latency: yield `ticks` microtasks. */
async function settle(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

describe("createShortcutOverrideStore", () => {
  it("persists a rebind", async () => {
    const h = createHarness();

    await h.store.set("new-workspace", "Mod+Shift+N");

    expect(h.cached()).toEqual({ "new-workspace": "Mod+Shift+N" });
    expect(h.persisted()).toEqual({ "new-workspace": "Mod+Shift+N" });
    expect(h.errors).toEqual([]);
  });

  it("distinguishes unassigned from absent", async () => {
    const h = createHarness();

    await h.store.clear("new-workspace");
    expect(h.persisted()).toEqual({ "new-workspace": null });

    await h.store.remove("new-workspace");
    expect(h.persisted()).toEqual({});
    expect(h.cached()).not.toHaveProperty("new-workspace");
  });

  it("reverts the cache and reports when the write fails", async () => {
    const h = createHarness({ seed: { "new-workspace": "Mod+1" }, failWrites: [1] });

    await h.store.clear("new-workspace");

    expect(h.cached()).toEqual({ "new-workspace": "Mod+1" });
    expect(h.persisted()).toEqual({ "new-workspace": "Mod+1" });
    expect(h.errors).toHaveLength(1);
  });

  it("drops the whole map on reset", async () => {
    const h = createHarness({ seed: { "new-workspace": "Mod+1" } });

    await h.store.resetAll();

    expect(h.cached()).toEqual({});
    expect(h.persisted()).toBeNull();
  });

  it("restores the map when the reset fails", async () => {
    const h = createHarness({ seed: { "new-workspace": "Mod+1" }, failRemove: true });

    await h.store.resetAll();

    expect(h.cached()).toEqual({ "new-workspace": "Mod+1" });
    expect(h.persisted()).toEqual({ "new-workspace": "Mod+1" });
    expect(h.errors).toHaveLength(1);
  });

  it("keeps the later of two changes to the same binding when the earlier write fails", async () => {
    const h = createHarness({ failWrites: [1] });

    // Both dispatched before either settles -- the settings row fires these
    // without awaiting.
    const first = h.store.set("new-workspace", "Mod+1");
    const second = h.store.set("new-workspace", "Mod+2");
    await Promise.all([first, second]);

    // The failed write must not roll its own stale value back over the one
    // that landed, or the row would show Mod+1 and the relaunch would fire
    // Mod+2.
    expect(h.cached()).toEqual({ "new-workspace": "Mod+2" });
    expect(h.persisted()).toEqual({ "new-workspace": "Mod+2" });
    expect(h.errors).toHaveLength(1);
  });

  it("keeps a rebind made after Reset all", async () => {
    const h = createHarness({ seed: { "new-workspace": "Mod+1" } });

    const reset = h.store.resetAll();
    const rebind = h.store.set("open-settings", "Mod+2");
    await Promise.all([reset, rebind]);

    // The removal must not land after the write, or the new binding is gone on
    // the next launch while the row still shows it.
    expect(h.cached()).toEqual({ "open-settings": "Mod+2" });
    expect(h.persisted()).toEqual({ "open-settings": "Mod+2" });
  });

  it("finishes each operation before starting the next", async () => {
    const h = createHarness();

    await Promise.all([h.store.set("a", "Mod+1"), h.store.set("b", "Mod+2")]);

    expect(h.events).toEqual([
      'cache {"a":"Mod+1"}',
      'write {"a":"Mod+1"}',
      'cache {"a":"Mod+1","b":"Mod+2"}',
      'write {"a":"Mod+1","b":"Mod+2"}',
    ]);
  });

  it("keeps running after a failed operation", async () => {
    const h = createHarness({ failWrites: [1] });

    await h.store.set("a", "Mod+1");
    await h.store.set("b", "Mod+2");

    expect(h.persisted()).toEqual({ b: "Mod+2" });
  });
});
