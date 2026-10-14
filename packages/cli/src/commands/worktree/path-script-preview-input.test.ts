import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildPathScriptPreviewInputs,
  parseRemoteOwnerAndRepo,
  type PathScriptPreviewContext,
} from "./path-script-preview-input.js";

const context: PathScriptPreviewContext = {
  repoPath: "/src/acme/widgets",
  owner: "acme",
  remoteRepo: "widgets",
  branchName: "feature/New Thing",
  mode: "branch-off",
  baseRef: "main",
  paseoHome: "/home/u/.paseo",
};

describe("buildPathScriptPreviewInputs", () => {
  it("emits the 10 argv values in contract order", () => {
    const { argv } = buildPathScriptPreviewInputs(context);
    expect(argv).toHaveLength(10);
    expect(argv.slice(0, 4)).toEqual(["/src/acme/widgets", "widgets", "acme", "widgets"]);
    expect(argv.slice(4)).toEqual([
      "feature/New Thing",
      "feature-new-thing",
      argv[6],
      "branch-off",
      "main",
      "/home/u/.paseo",
    ]);
  });

  it("emits env names in the same order as argv", () => {
    const { env } = buildPathScriptPreviewInputs(context);
    expect(Object.keys(env)).toEqual([
      "PASEO_REPO_PATH",
      "PASEO_REPO",
      "PASEO_OWNER",
      "PASEO_REMOTE_REPO",
      "PASEO_BRANCH_NAME",
      "PASEO_WORKTREE_SLUG",
      "PASEO_REPO_HASH",
      "PASEO_WORKTREE_MODE",
      "PASEO_BASE_REF",
      "PASEO_HOME",
    ]);
    expect(Object.values(env)).toEqual(buildPathScriptPreviewInputs(context).argv);
  });

  it("uses an explicit slug when given", () => {
    const { argv } = buildPathScriptPreviewInputs({ ...context, slug: "custom" });
    expect(argv[5]).toBe("custom");
  });

  it("keeps empty owner, remote repo, and base ref as empty strings", () => {
    const { argv, env } = buildPathScriptPreviewInputs({
      ...context,
      owner: "",
      remoteRepo: "",
      baseRef: "",
    });
    expect(argv[2]).toBe("");
    expect(argv[3]).toBe("");
    expect(argv[8]).toBe("");
    expect(env.PASEO_BASE_REF).toBe("");
  });

  it("derives the repo hash as the server does (sha256, 8 base36 chars)", () => {
    const digest = createHash("sha256").update("/src/acme/widgets").digest();
    let value = 0n;
    for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(digest[i]!);
    const expected = value.toString(36).padStart(13, "0").slice(0, 8);
    expect(buildPathScriptPreviewInputs(context).argv[6]).toBe(expected);
    expect(expected).toHaveLength(8);
  });
});

describe("parseRemoteOwnerAndRepo", () => {
  it("splits owner and repo from an https remote", () => {
    expect(parseRemoteOwnerAndRepo("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      remoteRepo: "widgets",
    });
  });

  it("keeps subgroups in the owner", () => {
    expect(parseRemoteOwnerAndRepo("git@gitlab.com:acme/platform/widgets.git")).toEqual({
      owner: "acme/platform",
      remoteRepo: "widgets",
    });
  });

  it("returns empty strings for unparseable remotes", () => {
    expect(parseRemoteOwnerAndRepo("not a remote")).toEqual({ owner: "", remoteRepo: "" });
  });
});
