import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createInMemoryKeyValueStorage } from "./fakes";
import {
  BACKLOG_PREFERENCES_QUERY_KEY,
  BACKLOG_PREFERENCES_STORAGE_KEY,
  DEFAULT_BACKLOG_PREFERENCES,
  loadBacklogPreferencesFromStorage,
  resolveBacklogViewMode,
  saveBacklogPreferences,
} from "./storage";

describe("loadBacklogPreferencesFromStorage", () => {
  it("defaults to unset view mode without writing storage", async () => {
    const storage = createInMemoryKeyValueStorage();

    const result = await loadBacklogPreferencesFromStorage(storage);

    expect(result).toEqual(DEFAULT_BACKLOG_PREFERENCES);
    expect(storage.entries.size).toBe(0);
  });

  it("loads an explicit grid preference", async () => {
    const storage = createInMemoryKeyValueStorage({
      [BACKLOG_PREFERENCES_STORAGE_KEY]: JSON.stringify({ viewMode: "grid" }),
    });

    await expect(loadBacklogPreferencesFromStorage(storage)).resolves.toEqual({
      viewMode: "grid",
    });
  });

  it("loads an explicit list preference", async () => {
    const storage = createInMemoryKeyValueStorage({
      [BACKLOG_PREFERENCES_STORAGE_KEY]: JSON.stringify({ viewMode: "list" }),
    });

    await expect(loadBacklogPreferencesFromStorage(storage)).resolves.toEqual({
      viewMode: "list",
    });
  });

  it("falls back safely for corrupt storage", async () => {
    const storage = createInMemoryKeyValueStorage({
      [BACKLOG_PREFERENCES_STORAGE_KEY]: "{not-json",
    });

    await expect(loadBacklogPreferencesFromStorage(storage)).resolves.toEqual(
      DEFAULT_BACKLOG_PREFERENCES,
    );
  });

  it("falls back safely for invalid viewMode values", async () => {
    const storage = createInMemoryKeyValueStorage({
      [BACKLOG_PREFERENCES_STORAGE_KEY]: JSON.stringify({ viewMode: "cards" }),
    });

    await expect(loadBacklogPreferencesFromStorage(storage)).resolves.toEqual(
      DEFAULT_BACKLOG_PREFERENCES,
    );
  });
});

describe("saveBacklogPreferences", () => {
  it("persists an explicit view mode choice", async () => {
    const storage = createInMemoryKeyValueStorage();
    const queryClient = new QueryClient();

    const next = await saveBacklogPreferences({
      queryClient,
      updates: { viewMode: "list" },
      storage,
    });

    expect(next).toEqual({ viewMode: "list" });
    expect(queryClient.getQueryData(BACKLOG_PREFERENCES_QUERY_KEY)).toEqual({ viewMode: "list" });
    expect(storage.entries.get(BACKLOG_PREFERENCES_STORAGE_KEY)).toBe(
      JSON.stringify({ viewMode: "list" }),
    );
  });
});

describe("resolveBacklogViewMode", () => {
  it("prefers the explicit user preference", () => {
    expect(resolveBacklogViewMode({ preference: "grid", isCompact: true })).toBe("grid");
    expect(resolveBacklogViewMode({ preference: "list", isCompact: false })).toBe("list");
  });

  it("defaults compact form factor to list when unset", () => {
    expect(resolveBacklogViewMode({ preference: null, isCompact: true })).toBe("list");
    expect(resolveBacklogViewMode({ preference: undefined, isCompact: true })).toBe("list");
  });

  it("defaults non-compact form factor to grid when unset", () => {
    expect(resolveBacklogViewMode({ preference: null, isCompact: false })).toBe("grid");
  });
});
