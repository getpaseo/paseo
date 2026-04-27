import { describe, expect, it } from "vitest";
import { buildWorkingDirectorySuggestions } from "./working-directory-suggestions";

describe("buildWorkingDirectorySuggestions", () => {
  it("returns de-duplicated recommendations when query is empty", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/hubcode", "/Users/me/projects/hubcode"],
      serverPaths: ["/Users/me/projects/playground"],
      query: "",
    });

    expect(results).toEqual(["/Users/me/projects/hubcode"]);
  });

  it("prioritizes matching recommended directories before server matches", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/hubcode", "/Users/me/documents"],
      serverPaths: [
        "/Users/me/projects/playground",
        "/Users/me/projects/hubcode",
        "/Users/me/projects/planbook",
      ],
      query: "pla",
    });

    expect(results).toEqual(["/Users/me/projects/playground", "/Users/me/projects/planbook"]);
  });

  it("puts matching recommended items first when they also match query", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/playground", "/Users/me/projects/hubcode"],
      serverPaths: ["/Users/me/projects/planbook", "/Users/me/projects/playground"],
      query: "pla",
    });

    expect(results).toEqual(["/Users/me/projects/playground", "/Users/me/projects/planbook"]);
  });

  it("treats '~' as an active query and includes server suggestions", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/hubcode"],
      serverPaths: ["/Users/me/documents", "/Users/me/projects"],
      query: "~",
    });

    expect(results).toEqual([
      "/Users/me/projects/hubcode",
      "/Users/me/documents",
      "/Users/me/projects",
    ]);
  });
});
