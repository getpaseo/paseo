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
      serverPaths: ["/Users/me/tmp", "/tmp", "/tmp/project"],
      query: "/tmp",
    });

    expect(results).toEqual(["/tmp", "/tmp/project"]);
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
