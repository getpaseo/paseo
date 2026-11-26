import { describe, expect, it } from "vitest";
import { resolveSearch, type SearchAnswer } from "./search-result";

const EMPTY: string[] = [];

function answer(overrides: Partial<SearchAnswer<string>> = {}): SearchAnswer<string> {
  return { hostId: "host-1", query: "app", items: ["/code/app"], error: null, ...overrides };
}

function resolve(overrides: Partial<Parameters<typeof resolveSearch<string>>[0]> = {}) {
  return resolveSearch<string>({
    enabled: true,
    hostId: "host-1",
    query: "app",
    debouncedQuery: "app",
    data: answer(),
    failed: null,
    empty: EMPTY,
    ...overrides,
  });
}

describe("resolveSearch", () => {
  it("shows the answer for the current query", () => {
    expect(resolve()).toEqual({ items: ["/code/app"], pending: false, error: null });
  });

  it("keeps the last items while the next query is pending", () => {
    expect(resolve({ query: "apps", debouncedQuery: "apps" })).toEqual({
      items: ["/code/app"],
      pending: true,
      error: null,
    });
  });

  it("never shows another host's answer, even for the same query", () => {
    expect(resolve({ hostId: "host-2" })).toEqual({ items: [], pending: true, error: null });
  });

  it("drops the last query's error while the next query is pending", () => {
    const failedAnswer = answer({ items: [], error: "Rate limited" });
    expect(resolve({ data: failedAnswer })).toEqual({
      items: [],
      pending: false,
      error: "Rate limited",
    });
    expect(resolve({ data: failedAnswer, query: "apps" })).toEqual({
      items: [],
      pending: true,
      error: null,
    });
  });

  it("shows a failed request only once the user stops typing", () => {
    expect(resolve({ data: undefined, failed: "Unable to search" })).toEqual({
      items: [],
      pending: false,
      error: "Unable to search",
    });
    expect(resolve({ data: undefined, failed: "Unable to search", query: "apps" })).toEqual({
      items: [],
      pending: true,
      error: null,
    });
  });

  it("is idle when disabled", () => {
    expect(resolve({ enabled: false })).toEqual({ items: [], pending: false, error: null });
  });
});
