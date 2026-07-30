import { describe, expect, it } from "vitest";
import { matchesAnySearchText, matchesSearchText, normalizeSearchQuery } from "./list-text-search";

describe("list-text-search", () => {
  it("normalizes query casing and whitespace", () => {
    expect(normalizeSearchQuery("  Hello World  ")).toBe("hello world");
  });

  it("matches case-insensitively", () => {
    expect(matchesSearchText("Claude Opus", "opus")).toBe(true);
    expect(matchesSearchText("Claude Opus", "gpt")).toBe(false);
    expect(matchesSearchText(null, "opus")).toBe(false);
    expect(matchesSearchText("Claude Opus", "")).toBe(true);
  });

  it("matches any provided field", () => {
    expect(matchesAnySearchText(["fix agent", "codex", "/tmp/repo"], "codex")).toBe(true);
    expect(matchesAnySearchText(["Fix agent", "codex", "/tmp/repo"], "repo")).toBe(true);
    expect(matchesAnySearchText(["Fix agent", "codex", "/tmp/repo"], "claude")).toBe(false);
    expect(matchesAnySearchText(["Fix agent", "codex", "/tmp/repo"], "  ")).toBe(true);
  });
});
