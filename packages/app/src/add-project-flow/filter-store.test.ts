import { beforeEach, describe, expect, it, vi } from "vitest";

import { readAddProjectSourceFilter, useAddProjectFilterStore } from "./filter-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("add-project source filter store", () => {
  beforeEach(() => {
    useAddProjectFilterStore.setState({ filterByHost: {} });
  });

  it("defaults to All when nothing is stored", () => {
    expect(readAddProjectSourceFilter({}, "host-1")).toBe("all");
    expect(readAddProjectSourceFilter({}, null)).toBe("all");
  });

  it("persists an explicit per-host selection without touching other hosts", () => {
    useAddProjectFilterStore.getState().setHostFilter("host-1", "local");
    useAddProjectFilterStore.getState().setHostFilter("host-2", "github");

    const { filterByHost } = useAddProjectFilterStore.getState();
    expect(readAddProjectSourceFilter(filterByHost, "host-1")).toBe("local");
    expect(readAddProjectSourceFilter(filterByHost, "host-2")).toBe("github");
    expect(readAddProjectSourceFilter(filterByHost, "host-3")).toBe("all");
  });

  it("drops the stored preference when the user returns to All", () => {
    const { setHostFilter } = useAddProjectFilterStore.getState();
    setHostFilter("host-1", "github");
    setHostFilter("host-1", "all");

    expect(useAddProjectFilterStore.getState().filterByHost).toEqual({});
    expect(readAddProjectSourceFilter({}, "host-1")).toBe("all");
  });
});
