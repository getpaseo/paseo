import { describe, expect, it } from "vitest";
import { buildWorkingDirectorySuggestions } from "./working-directory-suggestions";

describe("buildWorkingDirectorySuggestions", () => {
  it("returns de-duplicated recommendations when query is empty", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/paseo", "/Users/me/projects/paseo"],
      serverPaths: ["/Users/me/projects/playground"],
      query: "",
    });

    expect(results).toEqual(["/Users/me/projects/paseo"]);
  });

  it("prioritizes matching recommended directories before server matches", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/paseo", "/Users/me/documents"],
      serverPaths: [
        "/Users/me/projects/playground",
        "/Users/me/projects/paseo",
        "/Users/me/projects/planbook",
      ],
      query: "pla",
    });

    expect(results).toEqual(["/Users/me/projects/playground", "/Users/me/projects/planbook"]);
  });

  it("puts matching recommended items first when they also match query", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/playground", "/Users/me/projects/paseo"],
      serverPaths: ["/Users/me/projects/planbook", "/Users/me/projects/playground"],
      query: "pla",
    });

    expect(results).toEqual(["/Users/me/projects/playground", "/Users/me/projects/planbook"]);
  });

  it("keeps fuzzy server matches within the queried parent path", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: [
        "/Users/me/notprojects/paseo-desktop",
        "/Users/me/projects/archive/paseo-desktop",
        "/Users/me/projects/paseo-desktop",
      ],
      query: "~/projects/pso",
    });

    expect(results).toEqual(["/Users/me/projects/paseo-desktop"]);
  });

  it("normalizes dot-relative parent paths before filtering fuzzy matches", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: ["/Users/me/projects/paseo-desktop"],
      query: "./projects/pso",
    });

    expect(results).toEqual(["/Users/me/projects/paseo-desktop"]);
  });

  it("requires an exact parent path for absolute queries", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: ["/Users/me/tmp/foo/paseo", "/tmp/foo/paseo"],
      query: "/tmp/foo/pso",
    });

    expect(results).toEqual(["/tmp/foo/paseo"]);
  });

  it("preserves the root anchor for single-segment absolute queries", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: ["/Users/me/tmp", "/tmpfoo", "/tmp", "/tmp/project"],
      query: "/tmp",
    });

    expect(results).toEqual(["/tmp", "/tmp/project"]);
  });

  it("preserves Windows drive root anchors", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: ["C:\\tmpfoo", "C:\\tmp", "C:\\tmp\\project"],
      query: "C:\\tmp",
    });

    expect(results).toEqual(["C:\\tmp", "C:\\tmp\\project"]);
  });

  it("preserves UNC share root anchors", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: [
        "\\\\server\\share\\tmpfoo",
        "\\\\server\\share\\tmp",
        "\\\\server\\share\\tmp\\project",
      ],
      query: "\\\\server\\share\\tmp",
    });

    expect(results).toEqual(["\\\\server\\share\\tmp", "\\\\server\\share\\tmp\\project"]);
  });

  it.each([
    {
      kind: "Windows drive",
      query: "C:\\projects\\client\\pso",
      matchingPath: "C:\\projects\\client\\paseo",
      outsidePath: "C:\\archive\\client\\paseo",
    },
    {
      kind: "UNC share",
      query: "\\\\server\\share\\projects\\pso",
      matchingPath: "\\\\server\\share\\projects\\paseo",
      outsidePath: "\\\\server\\share\\archive\\paseo",
    },
  ])("keeps fuzzy basename matching below $kind roots", ({ query, matchingPath, outsidePath }) => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: [outsidePath, matchingPath],
      query,
    });

    expect(results).toEqual([matchingPath]);
  });

  it("keeps descendant matches for unrooted multi-segment searches", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: ["/Users/me/projects/paseo/packages/app"],
      query: "projects/paseo",
    });

    expect(results).toEqual(["/Users/me/projects/paseo/packages/app"]);
  });

  it("treats '~' as an active query and includes server suggestions", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/paseo"],
      serverPaths: ["/Users/me/documents", "/Users/me/projects"],
      query: "~",
    });

    expect(results).toEqual([
      "/Users/me/projects/paseo",
      "/Users/me/documents",
      "/Users/me/projects",
    ]);
  });
});
