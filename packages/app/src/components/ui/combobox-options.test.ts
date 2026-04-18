import { describe, expect, it } from "vitest";

import {
  buildVisibleComboboxOptions,
  filterAndRankComboboxOptions,
  getComboboxFallbackIndex,
  orderVisibleComboboxOptions,
} from "./combobox-options";

describe("buildVisibleComboboxOptions", () => {
  const options = [
    { id: "/Users/me/project-a", label: "/Users/me/project-a", kind: "directory" as const },
    { id: "/Users/me/project-b", label: "/Users/me/project-b", kind: "directory" as const },
  ];

  it("keeps a custom row visible while searching with no matches", () => {
    const visible = buildVisibleComboboxOptions({
      options,
      searchQuery: "/tmp/new-project",
      searchable: true,
      allowCustomValue: true,
      customValuePrefix: "",
      customValueKind: "directory",
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]).toEqual({
      id: "/tmp/new-project",
      label: "/tmp/new-project",
      description: undefined,
      kind: "directory",
    });
  });

  it("does not duplicate a row when search exactly matches an existing option", () => {
    const visible = buildVisibleComboboxOptions({
      options,
      searchQuery: "/Users/me/project-a",
      searchable: true,
      allowCustomValue: true,
      customValuePrefix: "",
      customValueKind: "directory",
    });

    expect(visible).toEqual([
      { id: "/Users/me/project-a", label: "/Users/me/project-a", kind: "directory" },
    ]);
  });
});

describe("filterAndRankComboboxOptions", () => {
  const options = [
    { id: "feat/login", label: "feat/login" },
    { id: "main", label: "main" },
    { id: "feat/main-nav", label: "feat/main-nav" },
    { id: "fix/logout", label: "fix/logout", description: "fixes main logout bug" },
  ];

  it("returns all options when search is empty", () => {
    expect(filterAndRankComboboxOptions(options, "")).toEqual(options);
  });

  it("filters by label substring", () => {
    const result = filterAndRankComboboxOptions(options, "login");
    expect(result.map((o) => o.id)).toEqual(["feat/login"]);
  });

  it("filters by id substring", () => {
    const result = filterAndRankComboboxOptions(options, "fix/");
    expect(result.map((o) => o.id)).toEqual(["fix/logout"]);
  });

  it("filters by description substring", () => {
    const result = filterAndRankComboboxOptions(options, "logout bug");
    expect(result.map((o) => o.id)).toEqual(["fix/logout"]);
  });

  it("ranks prefix matches above substring matches", () => {
    const result = filterAndRankComboboxOptions(options, "main");
    expect(result.map((o) => o.id)).toEqual(["main", "feat/main-nav", "fix/logout"]);
  });

  it("is case-insensitive", () => {
    const items = [{ id: "Alpha", label: "Alpha" }];
    expect(filterAndRankComboboxOptions(items, "alpha")).toHaveLength(1);
  });

  it("returns empty when nothing matches", () => {
    expect(filterAndRankComboboxOptions(options, "zzz")).toEqual([]);
  });
});

describe("combobox above-search ordering", () => {
  const visible = [
    { id: "/tmp/new-project", label: "/tmp/new-project", kind: "directory" as const },
    { id: "/Users/me/project-a", label: "/Users/me/project-a", kind: "directory" as const },
    { id: "/Users/me/project-b", label: "/Users/me/project-b", kind: "directory" as const },
  ];

  it("renders first logical option closest to the search box in above-search mode", () => {
    const ordered = orderVisibleComboboxOptions(visible, "above-search");
    expect(ordered.map((option) => option.id)).toEqual([
      "/Users/me/project-b",
      "/Users/me/project-a",
      "/tmp/new-project",
    ]);
    expect(getComboboxFallbackIndex(ordered.length, "above-search")).toBe(2);
  });

  it("keeps normal top-down order in below-search mode", () => {
    const ordered = orderVisibleComboboxOptions(visible, "below-search");
    expect(ordered.map((option) => option.id)).toEqual([
      "/tmp/new-project",
      "/Users/me/project-a",
      "/Users/me/project-b",
    ]);
    expect(getComboboxFallbackIndex(ordered.length, "below-search")).toBe(0);
  });
});
