import { describe, expect, it } from "vitest";
import { extractWorktreeSlug, shouldShowWorktreeSlug } from "./worktree-slug";

describe("extractWorktreeSlug", () => {
  describe("canonical worktree paths", () => {
    it("extracts slug from a POSIX worktree path", () => {
      expect(extractWorktreeSlug("/Users/dev/.paseo/worktrees/a1b2c3d4/puny-impala")).toBe(
        "puny-impala",
      );
    });

    it("extracts slug from a home-relative worktree path", () => {
      expect(extractWorktreeSlug("~/.paseo/worktrees/1vnnm9k3/tidy-fox")).toBe("tidy-fox");
    });

    it("extracts slug from a Linux home path", () => {
      expect(extractWorktreeSlug("/home/dev/.paseo/worktrees/abcdef12/my-feature")).toBe(
        "my-feature",
      );
    });

    it("extracts slug when path has trailing content (nested dir)", () => {
      expect(
        extractWorktreeSlug("/Users/dev/.paseo/worktrees/a1b2c3d4/puny-impala/projects/app"),
      ).toBe("puny-impala");
    });

    it("handles slashes in the slug (branch-style slugs)", () => {
      expect(
        extractWorktreeSlug("/Users/dev/.paseo/worktrees/a1b2c3d4/feature/login-refactor"),
      ).toBe("feature");
    });

    it("handles trailing slashes", () => {
      expect(extractWorktreeSlug("/Users/dev/.paseo/worktrees/a1b2c3d4/puny-impala/")).toBe(
        "puny-impala",
      );
    });
  });

  describe("Windows paths", () => {
    it("extracts slug from a Windows worktree path", () => {
      expect(extractWorktreeSlug("C:\\Users\\dev\\.paseo\\worktrees\\a1b2c3d4\\puny-impala")).toBe(
        "puny-impala",
      );
    });

    it("handles Windows trailing slash", () => {
      expect(
        extractWorktreeSlug("C:\\Users\\dev\\.paseo\\worktrees\\a1b2c3d4\\puny-impala\\"),
      ).toBe("puny-impala");
    });
  });

  describe("non-worktree paths", () => {
    it("returns null for a regular project directory", () => {
      expect(extractWorktreeSlug("/Users/dev/projects/my-app")).toBeNull();
    });

    it("returns null for a Linux home project directory", () => {
      expect(extractWorktreeSlug("/home/dev/projects/my-app")).toBeNull();
    });

    it("returns null for a relative path", () => {
      expect(extractWorktreeSlug("projects/my-app")).toBeNull();
    });

    it("returns null for undefined", () => {
      expect(extractWorktreeSlug(undefined)).toBeNull();
    });

    it("returns null for null", () => {
      expect(extractWorktreeSlug(null)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(extractWorktreeSlug("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(extractWorktreeSlug("   ")).toBeNull();
    });
  });

  describe("malformed paths", () => {
    it("returns null when only /worktrees/ with no hash or slug", () => {
      expect(extractWorktreeSlug("/worktrees/")).toBeNull();
    });

    it("returns null when /worktrees/ has only hash but no slug", () => {
      expect(extractWorktreeSlug("/worktrees/a1b2c3d4")).toBeNull();
    });

    it("returns null when /worktrees/ is at the end with trailing slash only", () => {
      expect(extractWorktreeSlug("/some/path/worktrees/")).toBeNull();
    });
  });
});

describe("shouldShowWorktreeSlug", () => {
  it("returns false when slug is null", () => {
    expect(shouldShowWorktreeSlug(null, "main")).toBe(false);
  });

  it("returns false when slug is empty", () => {
    expect(shouldShowWorktreeSlug("", "main")).toBe(false);
  });

  it("returns false when slug equals branch name", () => {
    expect(shouldShowWorktreeSlug("feature-login", "feature-login")).toBe(false);
  });

  it("returns true when slug differs from branch name", () => {
    expect(shouldShowWorktreeSlug("puny-impala", "feature/login")).toBe(true);
  });

  it("returns true when branch name is null and slug is valid", () => {
    expect(shouldShowWorktreeSlug("puny-impala", null)).toBe(true);
  });

  it("returns true when branch name is empty and slug is valid", () => {
    expect(shouldShowWorktreeSlug("puny-impala", "")).toBe(true);
  });

  it("is case-sensitive (different case means show)", () => {
    expect(shouldShowWorktreeSlug("Main", "main")).toBe(true);
  });
});
