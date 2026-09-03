import { describe, expect, it } from "vitest";
import { parsePluginForgeInput } from "./forge-validation.js";

describe("parsePluginForgeInput", () => {
  it("accepts valid read, checkout, merge, status, and lifecycle inputs", () => {
    expect(
      parsePluginForgeInput("listPullRequests", {
        cwd: "/repo",
        force: true,
        reason: "user refresh",
      }),
    ).toEqual({ cwd: "/repo", force: true, reason: "user refresh" });
    expect(
      parsePluginForgeInput("buildPrLocalBranchName", {
        headRef: "contributor/feature",
        checkoutTarget: {
          number: 7,
          baseRefName: "main",
          headRefName: "contributor/feature",
          checkoutRefs: [{ remoteUrl: "https://forge.example.com/repo.git", remoteRef: "head" }],
          headOwnerLogin: "contributor",
          preferredPushUrl: "https://forge.example.com/repo.git",
          headRepositorySshUrl: null,
          headRepositoryUrl: "https://forge.example.com/repo",
          isCrossRepository: true,
        },
      }),
    ).toMatchObject({
      headRef: "contributor/feature",
      checkoutTarget: { preferredPushUrl: "https://forge.example.com/repo.git" },
    });
    expect(
      parsePluginForgeInput("mergePullRequest", {
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "squash",
        status: {
          mergeable: "MERGEABLE",
          forgeSpecific: { forge: "acme", queue: "ready" },
        },
      }),
    ).toMatchObject({ mergeMethod: "squash" });
    expect(parsePluginForgeInput("invalidate", { cwd: "/repo" })).toEqual({ cwd: "/repo" });
    expect(parsePluginForgeInput("dispose", undefined)).toBeUndefined();
  });

  it.each([
    ["listPullRequests", { cwd: "" }],
    ["listPullRequests", { cwd: "/repo", force: true }],
    ["buildPrLocalBranchName", { headRef: "feature", checkoutTarget: { number: 7 } }],
    ["mergePullRequest", { cwd: "/repo", prNumber: 7, mergeMethod: "fast-forward" }],
    [
      "mergePullRequest",
      {
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "merge",
        status: { mergeable: "READY" },
      },
    ],
    ["getCurrentPullRequestStatus", { cwd: "/repo", headRef: "" }],
    ["probeHost", 42],
  ] as const)("rejects invalid %s input", (method, input) => {
    expect(() => parsePluginForgeInput(method, input)).toThrow(
      `Plugin forge ${method} received invalid input`,
    );
  });
});
