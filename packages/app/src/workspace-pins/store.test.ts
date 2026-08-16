import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";
import { usePinnedTargetsStore } from "./store";

describe("pinned targets persistence", () => {
  beforeEach(async () => {
    await AsyncStorage.removeItem("pinned-tab-targets");
    usePinnedTargetsStore.setState({ pinned: [] });
  });

  it("restores workspace review targets", async () => {
    await AsyncStorage.setItem(
      "pinned-tab-targets",
      JSON.stringify({
        state: {
          pinned: [{ kind: "working_diff" }, { kind: "files" }, { kind: "pull_request" }],
        },
        version: 1,
      }),
    );

    await usePinnedTargetsStore.persist.rehydrate();

    expect(usePinnedTargetsStore.getState().pinned).toEqual([
      { kind: "working_diff" },
      { kind: "files" },
      { kind: "pull_request" },
    ]);
  });
});
