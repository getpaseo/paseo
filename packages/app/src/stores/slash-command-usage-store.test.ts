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

import { useSlashCommandUsageStore } from "@/stores/slash-command-usage-store";

describe("slash-command-usage-store", () => {
  beforeEach(() => {
    useSlashCommandUsageStore.setState({
      usageCountsByCommand: {},
      recordUsage: useSlashCommandUsageStore.getState().recordUsage,
    });
  });

  it("increments usage counts by command name", () => {
    const store = useSlashCommandUsageStore.getState();

    store.recordUsage("gsd-plan-phase");
    store.recordUsage("gsd-plan-phase");
    store.recordUsage("gsd-debug");

    expect(useSlashCommandUsageStore.getState().usageCountsByCommand).toEqual({
      "gsd-debug": 1,
      "gsd-plan-phase": 2,
    });
  });

  it("ignores blank command names", () => {
    useSlashCommandUsageStore.getState().recordUsage("   ");

    expect(useSlashCommandUsageStore.getState().usageCountsByCommand).toEqual({});
  });
});
