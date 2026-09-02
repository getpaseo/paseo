import { describe, expect, test } from "vitest";

import { resolveCreateAgentTitles, resolveLastAgentTitle } from "./agent/create-agent-title.js";

describe("resolveCreateAgentTitles", () => {
  test("derives a provisional title from prompt when explicit title is absent", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: undefined,
      initialPrompt: "Implement auth retries with backoff\n\ninclude tests",
    });

    expect(resolved.explicitTitle).toBeNull();
    expect(resolved.provisionalTitle).toBe("Implement auth retries with backoff");
  });

  test("preserves explicit title and does not treat it as provisional", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: "  Keep This Title  ",
      initialPrompt: "Ignored prompt title",
    });

    expect(resolved.explicitTitle).toBe("Keep This Title");
    expect(resolved.provisionalTitle).toBe("Keep This Title");
  });

  test("returns null values when prompt and title are empty", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: "   ",
      initialPrompt: "   ",
    });

    expect(resolved.explicitTitle).toBeNull();
    expect(resolved.provisionalTitle).toBeNull();
  });
});

describe("resolveLastAgentTitle", () => {
  test("derives title from the last non-empty line of the prompt", () => {
    expect(resolveLastAgentTitle("Implement auth retries\n\nPlease also add tests")).toBe(
      "Please also add tests",
    );
  });

  test("skips empty lines when finding the last content line", () => {
    expect(resolveLastAgentTitle("First line\n\n\nLast meaningful line\n")).toBe(
      "Last meaningful line",
    );
  });

  test("returns the full line when it is short enough", () => {
    expect(resolveLastAgentTitle("Do the thing")).toBe("Do the thing");
  });

  test("clamps the title to the max character limit", () => {
    const longLine = "a".repeat(100);
    const result = resolveLastAgentTitle(longLine);
    expect(result).toHaveLength(60);
  });

  test("returns null for an all-whitespace prompt", () => {
    expect(resolveLastAgentTitle("   \n\n   ")).toBeNull();
  });

  test("handles single-line prompt the same as first-title logic", () => {
    expect(resolveLastAgentTitle("Single line prompt")).toBe("Single line prompt");
  });
});
