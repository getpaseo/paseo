import { beforeEach, describe, expect, it, vi } from "vitest";

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

describe("provider usage preferences", () => {
  beforeEach(() => {
    asyncStorage.clear();
    vi.resetModules();
  });

  it("restores the selected percentage display after the store reloads", async () => {
    const { useProviderUsagePreferences: firstStore } = await import("./preferences");
    await firstStore.persist.rehydrate();

    firstStore.getState().setPercentageDisplay("remaining");
    await vi.waitFor(() =>
      expect(asyncStorage.get("provider-usage-preferences")).toContain(
        '"percentageDisplay":"remaining"',
      ),
    );

    vi.resetModules();
    const { useProviderUsagePreferences: reloadedStore } = await import("./preferences");
    await reloadedStore.persist.rehydrate();

    expect(reloadedStore.getState().percentageDisplay).toBe("remaining");
  });
});
