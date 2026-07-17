import { z } from "zod";
import {
  defineForgeFacts,
  GITHUB_LINE_ANCHOR,
  type ClientForgeLogicModule,
  type MergeCapability,
} from "@/git/client-forge-module";
import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";

const GithubAutoMergeRequestSchema = z
  .object({
    enabledAt: z.string().nullable().optional().default(null),
    mergeMethod: z.string().nullable().optional().default(null),
    enabledBy: z.string().nullable().optional().default(null),
  })
  .nullable()
  .optional()
  .default(null);

const GithubRepositoryPolicySchema = z
  .object({
    autoMergeAllowed: z.boolean().optional().default(false),
    mergeCommitAllowed: z.boolean().optional().default(false),
    squashMergeAllowed: z.boolean().optional().default(false),
    rebaseMergeAllowed: z.boolean().optional().default(false),
    viewerDefaultMergeMethod: z.string().nullable().optional().default(null),
  })
  .optional()
  .default({
    autoMergeAllowed: false,
    mergeCommitAllowed: false,
    squashMergeAllowed: false,
    rebaseMergeAllowed: false,
    viewerDefaultMergeMethod: null,
  });

const GithubMergeFactsSchema = z
  .object({
    forge: z.literal("github"),
    mergeStateStatus: z.string().nullable().optional().default(null),
    autoMergeRequest: GithubAutoMergeRequestSchema,
    viewerCanEnableAutoMerge: z.boolean().optional().default(false),
    viewerCanDisableAutoMerge: z.boolean().optional().default(false),
    viewerCanMergeAsAdmin: z.boolean().optional().default(false),
    viewerCanUpdateBranch: z.boolean().optional().default(false),
    repository: GithubRepositoryPolicySchema,
    isMergeQueueEnabled: z.boolean().optional().default(false),
    isInMergeQueue: z.boolean().optional().default(false),
  })
  .passthrough();

type GithubMergeFacts = z.infer<typeof GithubMergeFactsSchema>;

const GITHUB_DIRECT_MERGE_STATE_ALLOWLIST = new Set(["CLEAN", "HAS_HOOKS"]);

function normalizeGithubMergeMethod(value: string | null): CheckoutPrMergeMethod | null {
  if (value === "SQUASH") return "squash";
  if (value === "MERGE") return "merge";
  if (value === "REBASE") return "rebase";
  return null;
}

function deriveGithubMergeCapability(github: GithubMergeFacts): MergeCapability {
  const repository = github.repository;
  const allowedMethods: CheckoutPrMergeMethod[] = [];
  if (repository.mergeCommitAllowed) allowedMethods.push("merge");
  if (repository.squashMergeAllowed) allowedMethods.push("squash");
  if (repository.rebaseMergeAllowed) allowedMethods.push("rebase");
  return {
    directMergeReady: GITHUB_DIRECT_MERGE_STATE_ALLOWLIST.has(github.mergeStateStatus ?? ""),
    canEnableAutoMerge:
      github.mergeStateStatus === "BLOCKED" &&
      repository.autoMergeAllowed &&
      github.viewerCanEnableAutoMerge,
    autoMergeEnabled: github.autoMergeRequest !== null,
    canDisableAutoMerge: github.viewerCanDisableAutoMerge === true,
    mergeBlockedByQueue: github.isMergeQueueEnabled || github.isInMergeQueue,
    allowedMethods,
    preferredMethod: normalizeGithubMergeMethod(repository.viewerDefaultMergeMethod ?? null),
  };
}

export const githubForgeLogic = {
  id: "github",
  urlGrammar: {
    treeInfix: "/tree/",
    blobInfix: "/blob/",
    lineAnchor: GITHUB_LINE_ANCHOR,
  },
  facts: defineForgeFacts({
    family: "github",
    schema: GithubMergeFactsSchema,
    deriveMergeCapability: deriveGithubMergeCapability,
  }),
} satisfies ClientForgeLogicModule<GithubMergeFacts>;
