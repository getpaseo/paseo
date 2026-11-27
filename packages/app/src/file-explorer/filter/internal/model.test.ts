import { describe, expect, it } from "vitest";
import { resolveFileFilterView, type FileFilterResponse } from "./model";

const RESPONSE: FileFilterResponse = {
  query: "re",
  entries: [
    { path: "data/nested/report.csv", kind: "file" },
    { path: "README.md", kind: "file" },
    { path: ".github/release", kind: "directory" },
  ],
};

function resolve(input: Partial<Parameters<typeof resolveFileFilterView>[0]>) {
  return resolveFileFilterView({
    query: "re",
    response: RESPONSE,
    error: null,
    isFetching: false,
    showHiddenFiles: true,
    ...input,
  });
}

describe("resolveFileFilterView", () => {
  it("names each match and the folder it is in, keeping the host's ranking", () => {
    expect(resolve({})).toEqual({
      status: "results",
      matches: [
        {
          path: "data/nested/report.csv",
          kind: "file",
          name: "report.csv",
          directory: "data/nested",
        },
        { path: "README.md", kind: "file", name: "README.md", directory: "" },
        { path: ".github/release", kind: "directory", name: "release", directory: ".github" },
      ],
    });
  });

  it("hides what the tree hides when hidden files are off", () => {
    expect(resolve({ showHiddenFiles: false })).toMatchObject({
      status: "results",
      matches: [{ path: "data/nested/report.csv" }, { path: "README.md" }],
    });
  });

  it("keeps the previous matches while the next query is searched", () => {
    expect(resolve({ query: "repo", isFetching: true })).toMatchObject({
      status: "results",
      matches: [{ path: "data/nested/report.csv" }, {}, {}],
    });
  });

  it("is loading until the current query has an answer", () => {
    expect(resolve({ response: undefined, isFetching: true })).toEqual({ status: "loading" });
    // The previous query matched nothing; that says nothing about this one.
    expect(resolve({ query: "repo", response: { query: "re", entries: [] } })).toEqual({
      status: "loading",
    });
  });

  it("is empty only when the current query matched nothing visible", () => {
    expect(resolve({ response: { query: "re", entries: [] } })).toEqual({ status: "empty" });
    expect(
      resolve({
        response: { query: "re", entries: [{ path: ".github/release", kind: "directory" }] },
        showHiddenFiles: false,
      }),
    ).toEqual({ status: "empty" });
  });

  it("reports why the search failed", () => {
    expect(resolve({ response: undefined, error: "Host disconnected" })).toEqual({
      status: "error",
      message: "Host disconnected",
    });
  });
});
