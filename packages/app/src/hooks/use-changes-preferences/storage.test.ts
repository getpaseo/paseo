import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createInMemoryKeyValueStorage } from "./fakes";
import {
  CHANGES_PREFERENCES_QUERY_KEY,
  CHANGES_PREFERENCES_STORAGE_KEY,
  DEFAULT_CHANGES_PREFERENCES,
  loadChangesPreferencesFromStorage,
  saveChangesPreferences,
} from "./storage";

describe("loadChangesPreferencesFromStorage", () => {
  it("defaults to unified layout with visible whitespace and writes the defaults back", async () => {
    const storage = createInMemoryKeyValueStorage();

    const result = await loadChangesPreferencesFromStorage(storage);

    expect(result).toEqual(DEFAULT_CHANGES_PREFERENCES);
    expect(storage.entries.get(CHANGES_PREFERENCES_STORAGE_KEY)).toBe(
      JSON.stringify(DEFAULT_CHANGES_PREFERENCES),
    );
  });

  it("migrates the legacy wrap-lines toggle into the new preferences object", async () => {
    const storage = createInMemoryKeyValueStorage({ "diff-wrap-lines": "true" });

    const result = await loadChangesPreferencesFromStorage(storage);

    expect(result).toEqual({
      layout: "unified",
      viewMode: "flat",
      wrapLines: true,
      hideWhitespace: false,
      fileView: "list",
      commitsCollapsed: true,
      commitsSectionHeight: 240,
    });
    expect(storage.entries.get(CHANGES_PREFERENCES_STORAGE_KEY)).toBe(JSON.stringify(result));
  });

  it("loads persisted layout and whitespace preferences without rewriting storage", async () => {
    const persisted = JSON.stringify({
      layout: "split",
      viewMode: "tree",
      hideWhitespace: true,
      wrapLines: false,
    });
    const storage = createInMemoryKeyValueStorage({
      [CHANGES_PREFERENCES_STORAGE_KEY]: persisted,
    });

    const result = await loadChangesPreferencesFromStorage(storage);

    expect(result).toEqual({
      layout: "split",
      viewMode: "tree",
      hideWhitespace: true,
      wrapLines: false,
      fileView: "list",
      commitsCollapsed: true,
      commitsSectionHeight: 240,
    });
    expect(storage.entries.get(CHANGES_PREFERENCES_STORAGE_KEY)).toBe(persisted);
    expect(storage.entries.size).toBe(1);
  });
});

describe("changes preferences fileView", () => {
  it("defaults fileView to list", () => {
    expect(DEFAULT_CHANGES_PREFERENCES.fileView).toBe("list");
  });

  it("round-trips fileView: tree", async () => {
    const storage = createInMemoryKeyValueStorage({
      [CHANGES_PREFERENCES_STORAGE_KEY]: JSON.stringify({ fileView: "tree" }),
    });

    const prefs = await loadChangesPreferencesFromStorage(storage);

    expect(prefs.fileView).toBe("tree");
  });

  it("falls back to list for invalid fileView", async () => {
    const storage = createInMemoryKeyValueStorage({
      [CHANGES_PREFERENCES_STORAGE_KEY]: JSON.stringify({ fileView: "bogus" }),
    });

    const prefs = await loadChangesPreferencesFromStorage(storage);

    expect(prefs.fileView).toBe("list");
  });
});

describe("changes preferences commitsCollapsed", () => {
  it("defaults commitsCollapsed to true", () => {
    expect(DEFAULT_CHANGES_PREFERENCES.commitsCollapsed).toBe(true);
  });

  it("round-trips commitsCollapsed: false", async () => {
    const storage = createInMemoryKeyValueStorage({
      [CHANGES_PREFERENCES_STORAGE_KEY]: JSON.stringify({ commitsCollapsed: false }),
    });

    const prefs = await loadChangesPreferencesFromStorage(storage);

    expect(prefs.commitsCollapsed).toBe(false);
  });

  it("falls back to true for invalid commitsCollapsed", async () => {
    const storage = createInMemoryKeyValueStorage({
      [CHANGES_PREFERENCES_STORAGE_KEY]: JSON.stringify({ commitsCollapsed: "nope" }),
    });

    const prefs = await loadChangesPreferencesFromStorage(storage);

    expect(prefs.commitsCollapsed).toBe(true);
  });
});

describe("changes preferences commitsSectionHeight", () => {
  it("defaults commitsSectionHeight to 240", () => {
    expect(DEFAULT_CHANGES_PREFERENCES.commitsSectionHeight).toBe(240);
  });

  it("round-trips commitsSectionHeight: 320", async () => {
    const storage = createInMemoryKeyValueStorage({
      [CHANGES_PREFERENCES_STORAGE_KEY]: JSON.stringify({ commitsSectionHeight: 320 }),
    });

    const prefs = await loadChangesPreferencesFromStorage(storage);

    expect(prefs.commitsSectionHeight).toBe(320);
  });

  it("falls back to 240 for invalid commitsSectionHeight", async () => {
    const storage = createInMemoryKeyValueStorage({
      [CHANGES_PREFERENCES_STORAGE_KEY]: JSON.stringify({ commitsSectionHeight: "tall" }),
    });

    const prefs = await loadChangesPreferencesFromStorage(storage);

    expect(prefs.commitsSectionHeight).toBe(240);
  });
});

describe("saveChangesPreferences", () => {
  it("merges updates onto cached preferences and persists the result", async () => {
    const storage = createInMemoryKeyValueStorage();
    const queryClient = new QueryClient();
    queryClient.setQueryData(CHANGES_PREFERENCES_QUERY_KEY, DEFAULT_CHANGES_PREFERENCES);

    await saveChangesPreferences({
      queryClient,
      updates: { layout: "split", viewMode: "tree", hideWhitespace: true },
      storage,
    });

    const expected = {
      ...DEFAULT_CHANGES_PREFERENCES,
      layout: "split",
      viewMode: "tree",
      hideWhitespace: true,
    };
    expect(queryClient.getQueryData(CHANGES_PREFERENCES_QUERY_KEY)).toEqual(expected);
    expect(storage.entries.get(CHANGES_PREFERENCES_STORAGE_KEY)).toBe(JSON.stringify(expected));
  });

  it("falls back to defaults when the query cache has no prior preferences", async () => {
    const storage = createInMemoryKeyValueStorage();
    const queryClient = new QueryClient();

    await saveChangesPreferences({
      queryClient,
      updates: { wrapLines: true },
      storage,
    });

    const expected = { ...DEFAULT_CHANGES_PREFERENCES, wrapLines: true };
    expect(storage.entries.get(CHANGES_PREFERENCES_STORAGE_KEY)).toBe(JSON.stringify(expected));
  });
});
