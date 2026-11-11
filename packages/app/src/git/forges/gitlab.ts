import { z } from "zod";
import {
  defineForgeFacts,
  type ClientForgeLogicModule,
  type MergeCapability,
} from "@/git/client-forge-module";
import type { CheckoutPipelineJob, CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";
import {
  CHECK_TRAIT_ACTION_REQUIRED,
  CHECK_TRAIT_MANUAL,
  CHECK_TRAIT_WARNING,
} from "@getpaseo/protocol/check-traits";
import { GITLAB_ACTIVE_PIPELINE_STATUS_SET } from "@getpaseo/protocol/gitlab-pipeline";
import type { CheckStatus } from "@/git/pull-request-panel/check-status";
import {
  classifyCheck,
  countCheckPresentations,
  type CheckPresentation,
  type CheckPresentationCounts,
  type PresentableCheck,
} from "@/git/check-presentation";

const gitlabLineAnchor = (start: number, end?: number): string =>
  end && end > start ? `#L${start}-${end}` : `#L${start}`;

export function isPipelineActiveStatus(status: string): boolean {
  return GITLAB_ACTIVE_PIPELINE_STATUS_SET.has(status);
}

export function mapPipelineStatus(status: string): CheckStatus {
  switch (status) {
    case "success":
    case "passed":
      return "success";
    case "failed":
      return "failure";
    case "canceled":
    case "cancelled":
    case "skipped":
      return "skipped";
    default:
      // "manual" and every active transitional status (see
      // GITLAB_ACTIVE_PIPELINE_STATUSES) render as pending.
      return "pending";
  }
}

type GitlabPipelineJobPresentationInput = Pick<CheckoutPipelineJob, "status" | "allowFailure">;

function toPresentableGitlabPipelineJob(job: GitlabPipelineJobPresentationInput): PresentableCheck {
  const status = mapPipelineStatus(job.status);
  if (job.status === "manual") {
    return {
      status,
      traits: job.allowFailure
        ? [CHECK_TRAIT_MANUAL]
        : [CHECK_TRAIT_MANUAL, CHECK_TRAIT_ACTION_REQUIRED],
    };
  }
  if (status === "failure" && job.allowFailure) return { status, traits: [CHECK_TRAIT_WARNING] };
  return { status };
}

export function classifyGitlabPipelineJob(
  job: GitlabPipelineJobPresentationInput,
): CheckPresentation {
  return classifyCheck(toPresentableGitlabPipelineJob(job));
}

export function countGitlabPipelineJobs(
  jobs: readonly CheckoutPipelineJob[],
): CheckPresentationCounts {
  return countCheckPresentations(jobs.map(toPresentableGitlabPipelineJob));
}

const GitlabMergeFactsSchema = z
  .object({
    forge: z.literal("gitlab"),
    detailedMergeStatus: z.string().nullable().optional().default(null),
    mergeStatus: z.string().nullable().optional().default(null),
    hasConflicts: z.boolean().optional().default(false),
    blockingDiscussionsResolved: z.boolean().optional().default(true),
    approvalsRequired: z.number().optional().default(0),
    approvalsGiven: z.number().optional().default(0),
    pipelineStatus: z.string().nullable().optional().default(null),
    pipelineId: z.number().nullable().optional().default(null),
    pipelineUrl: z.string().nullable().optional().default(null),
    mergeWhenPipelineSucceeds: z.boolean().optional().default(false),
  })
  .passthrough();

export type GitlabMergeFacts = z.infer<typeof GitlabMergeFactsSchema>;

export { GitlabMergeFactsSchema };

const GITLAB_MERGEABLE_STATUS = "mergeable";
const GITLAB_LEGACY_MERGEABLE_STATUS = "can_be_merged";
const GITLAB_MERGE_METHODS: CheckoutPrMergeMethod[] = ["merge", "squash", "rebase"];

/**
 * Direct-merge readiness from GitLab's merge signals. `detailedMergeStatus` is
 * GitLab 15.6+ only; when it is absent (older self-managed instances) fall back
 * to the legacy `mergeStatus === "can_be_merged"` with no conflicts so merge is
 * not silently refused everywhere.
 */
function isGitlabDirectMergeReady(gitlab: GitlabMergeFacts): boolean {
  if (gitlab.detailedMergeStatus != null) {
    return gitlab.detailedMergeStatus === GITLAB_MERGEABLE_STATUS;
  }
  return gitlab.mergeStatus === GITLAB_LEGACY_MERGEABLE_STATUS && gitlab.hasConflicts !== true;
}

function deriveGitlabMergeCapability(gitlab: GitlabMergeFacts): MergeCapability {
  const autoMergeEnabled = gitlab.mergeWhenPipelineSucceeds === true;
  const hasActivePipeline =
    gitlab.pipelineStatus !== null && isPipelineActiveStatus(gitlab.pipelineStatus);
  return {
    directMergeReady: isGitlabDirectMergeReady(gitlab),
    canEnableAutoMerge: !autoMergeEnabled && hasActivePipeline,
    autoMergeEnabled,
    canDisableAutoMerge: autoMergeEnabled,
    mergeBlockedByQueue: false,
    allowedMethods: GITLAB_MERGE_METHODS,
    preferredMethod: null,
  };
}

export interface GitlabPipelineSummary {
  id: number;
  status: CheckStatus;
  rawStatus: string;
  url: string | null;
}

export interface GitlabApprovals {
  given: number;
  required: number;
}

export function deriveGitlabPipelineSummary(facts: GitlabMergeFacts): GitlabPipelineSummary | null {
  if (facts.pipelineId == null) {
    return null;
  }
  const rawStatus = facts.pipelineStatus ?? "";
  return {
    id: facts.pipelineId,
    status: mapPipelineStatus(rawStatus),
    rawStatus,
    url: facts.pipelineUrl ?? null,
  };
}

export function deriveGitlabApprovals(facts: GitlabMergeFacts): GitlabApprovals | null {
  const required = facts.approvalsRequired ?? 0;
  if (required <= 0) {
    return null;
  }
  return { given: facts.approvalsGiven ?? 0, required };
}

export const gitlabForgeLogic = {
  id: "gitlab",
  urlGrammar: {
    treeInfix: "/-/tree/",
    blobInfix: "/-/blob/",
    lineAnchor: gitlabLineAnchor,
    changeRequestChecksSuffix: "/pipelines",
    referencePaths: [
      { kind: "change_request", infix: "/-/merge_requests/" },
      { kind: "issue", infix: "/-/issues/" },
    ],
  },
  facts: defineForgeFacts({
    family: "gitlab",
    schema: GitlabMergeFactsSchema,
    deriveMergeCapability: deriveGitlabMergeCapability,
  }),
} satisfies ClientForgeLogicModule<GitlabMergeFacts>;
