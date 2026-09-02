import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBranchPrefix,
  normalizeBranchPrefix,
  slugify,
  validateBranchSlug,
} from "./branch-slug.js";

describe("branch slug utilities", () => {
  it("normalizes display names to lowercase branch slugs", () => {
    expect(slugify("My Feature")).toBe("my-feature");
  });

  it("collapses punctuation and whitespace to a single hyphen", () => {
    expect(slugify("My___Feature! @#$ Next")).toBe("my-feature-next");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify(" --- My Feature !!! ")).toBe("my-feature");
  });

  it("enforces the 50 character slug limit", () => {
    const slug = slugify("a".repeat(60));

    expect(slug).toBe("a".repeat(50));
  });

  it("validates branch slugs with clear messages", () => {
    expect(validateBranchSlug("my-feature")).toEqual({ valid: true });
    expect(validateBranchSlug("")).toEqual({
      valid: false,
      error: "Branch name cannot be empty",
    });
    expect(validateBranchSlug("My Feature")).toEqual({
      valid: false,
      error:
        "Branch name must contain only lowercase letters, numbers, hyphens, and forward slashes",
    });
    expect(validateBranchSlug("-my-feature")).toEqual({
      valid: false,
      error: "Branch name cannot start or end with a hyphen",
    });
  });

  it("normalizes branch prefixes to a safe path segment", () => {
    expect(normalizeBranchPrefix("Alice")).toBe("alice");
    expect(normalizeBranchPrefix("  team/eng  ")).toBe("team/eng");
    expect(normalizeBranchPrefix("//alice//")).toBe("alice");
    expect(normalizeBranchPrefix("Team Eng!")).toBe("team-eng-");
    expect(normalizeBranchPrefix("-foobar")).toBe("foobar");
    expect(normalizeBranchPrefix("")).toBe("");
  });

  it("preserves a trailing hyphen or underscore as the separator marker", () => {
    expect(normalizeBranchPrefix("foobar-")).toBe("foobar-");
    expect(normalizeBranchPrefix("foobar_")).toBe("foobar_");
    expect(normalizeBranchPrefix("foobar----")).toBe("foobar----");
    expect(normalizeBranchPrefix("foo-bar")).toBe("foo-bar");
  });

  it("applies a normalized prefix to a branch name with a slash by default", () => {
    expect(applyBranchPrefix("tokyo", "alice")).toBe("alice/tokyo");
    expect(applyBranchPrefix("tokyo", "  Alice  ")).toBe("alice/tokyo");
    expect(applyBranchPrefix("tokyo", "")).toBe("tokyo");
    expect(applyBranchPrefix("tokyo", undefined)).toBe("tokyo");
    expect(applyBranchPrefix("auto-branch-name", "foo-bar")).toBe("foo-bar/auto-branch-name");
  });

  it("attaches directly when the prefix already ends in a hyphen or underscore", () => {
    expect(applyBranchPrefix("auto-branch-name", "foobar-")).toBe("foobar-auto-branch-name");
    expect(applyBranchPrefix("auto-branch-name", "foobar_")).toBe("foobar_auto-branch-name");
    expect(applyBranchPrefix("auto-branch-name", "foobar----")).toBe("foobar----auto-branch-name");
  });

  it("does not import server-only modules", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(currentDir, "branch-slug.ts"), "utf8");

    expect(source).not.toMatch(
      /from\s+["'](?:node:)?(?:fs|path|child_process)["']|from\s+["']node:/,
    );
  });
});
