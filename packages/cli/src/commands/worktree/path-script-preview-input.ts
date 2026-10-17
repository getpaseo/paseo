import { createHash } from "node:crypto";
import { basename } from "node:path";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { slugify } from "@getpaseo/protocol/branch-slug";

export const PATH_SCRIPT_MODES = [
  "branch-off",
  "checkout-branch",
  "checkout-change-request",
  "checkout-github-pr",
] as const;

export type PathScriptMode = (typeof PATH_SCRIPT_MODES)[number];

export interface PathScriptPreviewContext {
  repoPath: string;
  owner: string;
  remoteRepo: string;
  branchName: string;
  slug?: string;
  mode: PathScriptMode;
  baseRef: string;
  paseoHome: string;
}

export interface PathScriptPreviewInputs {
  argv: string[];
  env: Record<string, string>;
}

export function buildPathScriptPreviewInputs(
  context: PathScriptPreviewContext,
): PathScriptPreviewInputs {
  const repoHash = deriveRepoHash(context.repoPath);
  // The server normalizes slugs (worktree-core slugify) before the script
  // runs; an explicit --slug gets the same treatment here.
  const slug = slugify(context.slug ?? context.branchName);
  const repo = basename(context.repoPath);
  const values: Array<[string, string]> = [
    ["PASEO_REPO_PATH", context.repoPath],
    ["PASEO_REPO", repo],
    ["PASEO_OWNER", context.owner],
    ["PASEO_REMOTE_REPO", context.remoteRepo],
    ["PASEO_BRANCH_NAME", context.branchName],
    ["PASEO_WORKTREE_SLUG", slug],
    ["PASEO_REPO_HASH", repoHash],
    ["PASEO_WORKTREE_MODE", context.mode],
    ["PASEO_BASE_REF", context.baseRef],
    ["PASEO_HOME", context.paseoHome],
  ];
  return {
    argv: values.map(([, value]) => value),
    env: Object.fromEntries(values),
  };
}

// Same derivation as deriveWorktreeRepoHash in packages/server/src/utils/worktree-path-script.ts
// (SHA-256 of the repo root, first 8 digest bytes as base36, 8 chars). Duplicated
// because the CLI cannot import server internals and protocol source must stay
// free of node:crypto for the mobile bundle; both sides pin the algorithm with
// an independently recomputed known-answer test.
function deriveRepoHash(repoPath: string): string {
  const digest = createHash("sha256").update(repoPath).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, 8);
}

/**
 * Owner is every path segment but the last (subgroups kept, joined with "/");
 * remoteRepo is the last segment. Empty strings when the URL is unparseable.
 */
export function parseRemoteOwnerAndRepo(remoteUrl: string): {
  owner: string;
  remoteRepo: string;
} {
  const empty = { owner: "", remoteRepo: "" };
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location) {
    return empty;
  }
  const segments = location.path.split("/").filter((segment) => segment.length > 0);
  const remoteRepo = segments[segments.length - 1] ?? "";
  if (!remoteRepo) {
    return empty;
  }
  return { owner: segments.slice(0, -1).join("/"), remoteRepo };
}
