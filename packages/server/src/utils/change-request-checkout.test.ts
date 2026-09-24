import { describe, expect, it } from "vitest";

import {
  buildForkLocalBranchName,
  normalizeForgeOwnerForBranch,
} from "./change-request-checkout.js";

describe("normalizeForgeOwnerForBranch", () => {
  it("lowercases a valid login", () => {
    expect(normalizeForgeOwnerForBranch("Contributor")).toBe("contributor");
  });

  it("allows dots and underscores", () => {
    expect(normalizeForgeOwnerForBranch("a.b_c")).toBe("a.b_c");
  });

  it("rejects a login starting with a dash", () => {
    expect(normalizeForgeOwnerForBranch("-abc")).toBeNull();
  });

  it("rejects a login starting with a dot", () => {
    expect(normalizeForgeOwnerForBranch(".hidden")).toBeNull();
  });

  it("rejects a login containing '..'", () => {
    expect(normalizeForgeOwnerForBranch("a..b")).toBeNull();
  });

  it("rejects a login ending in .lock", () => {
    expect(normalizeForgeOwnerForBranch("contributor.lock")).toBeNull();
  });

  it("rejects a login with a path traversal segment", () => {
    expect(normalizeForgeOwnerForBranch("../evil")).toBeNull();
  });

  it("rejects an empty or null login", () => {
    expect(normalizeForgeOwnerForBranch(null)).toBeNull();
    expect(normalizeForgeOwnerForBranch("")).toBeNull();
    expect(normalizeForgeOwnerForBranch("   ")).toBeNull();
  });
});

describe("buildForkLocalBranchName", () => {
  const fork = { headRef: "patch-1", number: 42, isCrossRepository: true };

  it("keeps the head ref for a same-repository head", () => {
    expect(
      buildForkLocalBranchName({ ...fork, isCrossRepository: false, headOwnerLogin: "arthur" }),
    ).toBe("patch-1");
  });

  it("prefixes a fork head with the lowercased owner", () => {
    expect(buildForkLocalBranchName({ ...fork, headOwnerLogin: "Arthur" })).toBe("arthur/patch-1");
  });

  it("falls back to the pr number when the owner is unknown", () => {
    expect(buildForkLocalBranchName({ ...fork, headOwnerLogin: null })).toBe("pr-42/patch-1");
  });

  it("falls back to the pr number when the owner is not a safe ref segment", () => {
    expect(buildForkLocalBranchName({ ...fork, headOwnerLogin: "-zaphod" })).toBe("pr-42/patch-1");
  });
});
