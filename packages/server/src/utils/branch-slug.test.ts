import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { slugify, validateBranchSlug } from "./branch-slug.js";

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

  it("is exported through the package subpath", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(
      readFileSync(join(currentDir, "..", "..", "package.json"), "utf8"),
    ) as {
      exports?: Record<string, { types?: string; source?: string; default?: string }>;
    };

    expect(packageJson.exports?.["./utils/branch-slug"]).toEqual({
      types: "./dist/server/utils/branch-slug.d.ts",
      source: "./src/utils/branch-slug.ts",
      default: "./dist/server/utils/branch-slug.js",
    });
  });

  it("does not import server-only modules", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(currentDir, "branch-slug.ts"), "utf8");

    expect(source).not.toMatch(
      /from\s+["'](?:node:)?(?:fs|path|child_process)["']|from\s+["']node:/,
    );
  });
});
