import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineForgeClientProvider,
  defineForgeFacts,
  defineForgeServerProvider,
  ForgeAuthenticationError,
  formatCheckDuration,
  GITHUB_LINE_ANCHOR,
  GITLAB_LINE_ANCHOR,
  renderForgeLineAnchor,
  ForgeCliMissingError,
  ForgeCommandError,
  type PluginForgeServerService,
  type PullRequestCheck,
} from "./forge.js";

describe("Forge plugin definitions", () => {
  it("exposes open Forge check traits through the SDK contract", () => {
    const check: PullRequestCheck = {
      name: "Deploy approval",
      status: "skipped",
      url: null,
      traits: ["manual", "future-forge-trait"],
    };

    expect(check.traits).toEqual(["manual", "future-forge-trait"]);
  });

  it("preserves a typed client facts derivation and declarative brand view", () => {
    const schema = z.object({ forge: z.literal("acme"), ready: z.boolean() });
    const provider = defineForgeClientProvider({
      definition: {
        id: "acme",
        displayName: "Acme",
        changeRequestAbbrev: "MR",
        changeRequestNoun: "merge request",
        changeRequestNumberPrefix: "!",
        issueNumberPrefix: "#",
        signIn: null,
        cloudHosts: ["code.acme.test"],
      },
      facts: defineForgeFacts({
        family: "acme",
        schema,
        deriveMergeCapability: (facts) => ({
          directMergeReady: facts.ready,
          canEnableAutoMerge: false,
          autoMergeEnabled: false,
          canDisableAutoMerge: false,
          mergeBlockedByQueue: false,
          allowedMethods: ["squash"],
          preferredMethod: "squash",
        }),
      }),
      view: {
        icon: { kind: "svg-path", viewBox: [0, 0, 24, 24], path: "M0 0h24v24H0z" },
        brandColor: { light: "#123456", dark: "#abcdef" },
      },
    });

    expect(provider.definition.id).toBe("acme");
    expect(provider.facts?.deriveMergeCapability?.({ forge: "acme", ready: true })).toEqual({
      directMergeReady: true,
      canEnableAutoMerge: false,
      autoMergeEnabled: false,
      canDisableAutoMerge: false,
      mergeBlockedByQueue: false,
      allowedMethods: ["squash"],
      preferredMethod: "squash",
    });
    expect(provider.view?.icon.kind).toBe("svg-path");
  });

  it("leaves schema parsing to the host before deriving merge capability", () => {
    let transformCalls = 0;
    const facts = defineForgeFacts({
      family: "acme" as const,
      schema: z.object({ forge: z.literal("acme"), ready: z.boolean() }).transform((value) => {
        transformCalls += 1;
        return value;
      }),
      deriveMergeCapability: ({ ready }) => ({
        directMergeReady: ready,
        canEnableAutoMerge: false,
        autoMergeEnabled: false,
        canDisableAutoMerge: false,
        mergeBlockedByQueue: false,
        allowedMethods: ["merge"],
        preferredMethod: "merge",
      }),
    });
    const parsed = facts.schema.parse({ forge: "acme", ready: true });

    expect(facts.deriveMergeCapability?.(parsed)).toMatchObject({ directMergeReady: true });
    expect(transformCalls).toBe(1);
  });

  it("preserves server providers and classifies forge failures", () => {
    const service = {
      listPullRequests: async () => [],
      listIssues: async () => [],
      getPullRequest: async () => {
        throw new Error("not used");
      },
      getPullRequestHeadRef: async () => "feature/acme",
      getPullRequestCheckoutTarget: async () => ({
        number: 1,
        baseRefName: "main",
        headRefName: "feature/acme",
        headOwnerLogin: null,
        headRepositorySshUrl: null,
        headRepositoryUrl: null,
        isCrossRepository: false,
      }),
      getCurrentPullRequestStatus: async () => null,
      getPullRequestTimeline: async () => ({
        prNumber: 1,
        repoOwner: "acme",
        repoName: "repo",
        items: [],
        truncated: false,
        error: null,
      }),
      getCheckDetails: async () => ({
        checkRunId: 1,
        name: "build",
        annotations: [],
        failedJobs: [],
        truncated: false,
      }),
      searchIssuesAndPrs: async () => ({
        items: [],
        featuresEnabled: true,
        authState: "authenticated" as const,
      }),
      createPullRequest: async () => ({ url: "https://code.acme.test/acme/repo/1", number: 1 }),
      mergePullRequest: async () => ({ success: true as const }),
      enablePullRequestAutoMerge: async () => ({ success: true as const }),
      disablePullRequestAutoMerge: async () => ({ success: true as const }),
      isAuthenticated: async () => true,
      invalidate() {},
    } satisfies PluginForgeServerService;
    const provider = defineForgeServerProvider({
      definition: {
        id: "acme",
        displayName: "Acme",
        changeRequestAbbrev: "MR",
        changeRequestNoun: "merge request",
        changeRequestNumberPrefix: "!",
        issueNumberPrefix: "#",
        signIn: null,
      },
      service,
    });

    expect(provider.service).toBe(service);
    expect(new ForgeCliMissingError("missing").kind).toBe("missing-cli");
    expect(new ForgeAuthenticationError("sign in", { stderr: "expired" }).kind).toBe(
      "auth-failure",
    );
    const commandError = new ForgeCommandError(
      { brand: "Acme", binary: "acme" },
      {
        args: ["merge", "--body", "sensitive body"],
        cwd: "/sensitive/repo",
        exitCode: 1,
        stderr: "sensitive stderr",
      },
    );
    expect(commandError.kind).toBe("command-error");
    expect(commandError.message).toBe("Acme CLI command failed: acme");
    expect(commandError.args).toEqual(["merge", "--body", "sensitive body"]);
    expect(commandError.cwd).toBe("/sensitive/repo");
    expect(commandError.stderr).toBe("sensitive stderr");
    for (const key of ["brand", "binary", "args", "cwd", "stderr"]) {
      expect(Object.keys(commandError)).not.toContain(key);
    }
  });
});

describe("formatCheckDuration", () => {
  it("formats sub-minute and multi-minute spans", () => {
    expect(formatCheckDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:42Z")).toBe("42s");
    expect(formatCheckDuration("2026-01-01T00:00:00Z", "2026-01-01T00:03:07Z")).toBe("3m 7s");
  });

  it("returns undefined for a missing, unparsable, or non-advancing span", () => {
    expect(formatCheckDuration(null, "2026-01-01T00:00:42Z")).toBeUndefined();
    expect(formatCheckDuration("2026-01-01T00:00:00Z", null)).toBeUndefined();
    expect(formatCheckDuration("not a date", "2026-01-01T00:00:42Z")).toBeUndefined();
    expect(formatCheckDuration("2026-01-01T00:00:42Z", "2026-01-01T00:00:42Z")).toBeUndefined();
  });
});

describe("renderForgeLineAnchor", () => {
  it("renders the shipped GitHub and GitLab shapes", () => {
    expect(renderForgeLineAnchor(GITHUB_LINE_ANCHOR, 12)).toBe("#L12");
    expect(renderForgeLineAnchor(GITHUB_LINE_ANCHOR, 12, 20)).toBe("#L12-L20");
    expect(renderForgeLineAnchor(GITLAB_LINE_ANCHOR, 12, 20)).toBe("#L12-20");
  });

  it("renders a shape neither built-in style can express", () => {
    const anchor = { single: "#line-{start}", range: "#lines-{start}..{end}" };

    expect(renderForgeLineAnchor(anchor, 3)).toBe("#line-3");
    expect(renderForgeLineAnchor(anchor, 3, 9)).toBe("#lines-3..9");
  });

  it("uses the single template when a forge has no range syntax", () => {
    expect(renderForgeLineAnchor({ single: "#L{start}" }, 4, 10)).toBe("#L4");
  });

  it("treats a collapsed or trailing-backwards range as a single line", () => {
    expect(renderForgeLineAnchor(GITHUB_LINE_ANCHOR, 7, 7)).toBe("#L7");
    expect(renderForgeLineAnchor(GITHUB_LINE_ANCHOR, 7, 3)).toBe("#L7");
  });
});
