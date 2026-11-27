import { describe, expect, it } from "vitest";
import type { PullRequestCheckoutTarget } from "@getpaseo/plugin/server";
import { parsePluginForgeResult } from "./forge-validation.js";

describe("plugin Forge checkout targets", () => {
  it.each(["branch", "pull-ref"] as const)("preserves the %s head kind", (headRefKind) => {
    const target: PullRequestCheckoutTarget = {
      number: 7,
      baseRefName: "main",
      headRefName: "refs/pull/7/head",
      headRefKind,
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    };

    expect(parsePluginForgeResult("getPullRequestCheckoutTarget", target)).toEqual(target);
  });
});
