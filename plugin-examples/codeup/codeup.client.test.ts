import { describe, expect, it } from "vitest";
import { codeupClientProvider } from "./client/codeup";

describe("Codeup client forge contribution", () => {
  it("declares Codeup presentation and its Alibaba Cloud CLI setup", () => {
    expect(codeupClientProvider.definition).toEqual({
      id: "codeup",
      displayName: "Codeup",
      changeRequestAbbrev: "MR",
      changeRequestNoun: "merge request",
      changeRequestNumberPrefix: "!",
      issueNumberPrefix: "#",
      signIn: { cli: "aliyun", command: "aliyun configure" },
      cloudHosts: ["codeup.aliyun.com"],
    });
    expect(codeupClientProvider.view).toMatchObject({
      icon: { kind: "svg-path", viewBox: [0, 0, 24, 24] },
      brandColor: { light: "#FF6A00", dark: "#FF6A00" },
    });
    expect(codeupClientProvider.view?.icon.path).toContain("M12 1.5");
  });

  it("derives direct merge readiness and all supported merge methods", () => {
    const facts = {
      forge: "codeup",
      status: "TO_BE_MERGED",
      allRequirementsPass: true,
      requirementChecks: {
        mergeConflict: true,
        comments: true,
        ci: true,
        reviewerApproved: true,
      },
    };
    expect(codeupClientProvider.facts?.schema.parse(facts)).toEqual(facts);
    expect(codeupClientProvider.facts?.deriveMergeCapability?.(facts)).toEqual({
      directMergeReady: true,
      canEnableAutoMerge: false,
      autoMergeEnabled: false,
      canDisableAutoMerge: false,
      mergeBlockedByQueue: false,
      allowedMethods: ["merge", "squash", "rebase"],
      preferredMethod: null,
    });
    expect(
      codeupClientProvider.facts?.deriveMergeCapability?.({
        ...facts,
        requirementChecks: { ...facts.requirementChecks, ci: false },
      }).directMergeReady,
    ).toBe(false);
  });
});
