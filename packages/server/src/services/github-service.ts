import { z } from "zod";
import {
  isGitHubHost,
  parseGitHubRemoteUrl,
  parseGitRemoteLocation,
} from "@getpaseo/protocol/git-remote";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { execCommand } from "../utils/spawn.js";
import { resolveSshHostname } from "../utils/ssh-hostname.js";
import {
  CLI_AUTH_PROBE_TIMEOUT_MS,
  createForgeCliRunner,
  ForgeAuthenticationError,
  ForgeCliMissingError,
  parseCliJsonOutput,
  probeHostViaCliAuthStatus,
  ForgeCommandError,
  type ForgeCommandFailureParams,
} from "./forge-cli-command.js";
import {
  computeChecksStatus,
  compareTimelineItems,
  createUnavailableSearchResult,
  normalizeForgeSearchKinds,
  parseOptionalTime,
} from "./forge-service.js";
import type {
  CheckAnnotation,
  CheckDetails,
  CheckFailedJob,
  CurrentPullRequestStatus,
  DisablePullRequestAutoMergeOptions,
  EnablePullRequestAutoMergeOptions,
  ForgeReadOptions,
  ForgeService,
  IssueSummary,
  MergePullRequestOptions,
  PullRequestCheck,
  PullRequestCheckoutTarget,
  PullRequestCheckStatus,
  PullRequestCommandStatus,
  PullRequestMergeMethod,
  PullRequestReviewDecision,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineError,
  PullRequestTimelineErrorKind,
  PullRequestTimelineItem,
  PullRequestTimelineReviewState,
  SearchResult,
} from "./forge-service.js";
import {
  isGitHubPullRequestStatusFacts,
  type GitHubPullRequestStatusFacts,
} from "./github-facts.js";

export type {
  CheckAnnotation,
  CheckDetails,
  CheckFailedJob,
  CreatePullRequestOptions,
  CurrentPullRequestStatus,
  DisablePullRequestAutoMergeOptions,
  EnablePullRequestAutoMergeOptions,
  ForgeAuthState,
  ForgeReadOptions,
  ForgeService,
  ForgeSpecificStatusFacts,
  GetCheckDetailsOptions,
  GetPullRequestOptions,
  GetPullRequestTimelineOptions,
  IssueSummary,
  ListIssuesOptions,
  ListPullRequestsOptions,
  MergePullRequestOptions,
  PullRequestAutoMergeResult,
  PullRequestCheck,
  PullRequestCheckoutTarget,
  PullRequestChecksStatus,
  PullRequestCheckStatus,
  PullRequestCommandStatus,
  PullRequestCreateResult,
  PullRequestMergeable,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestReviewDecision,
  PullRequestSummary,
  PullRequestTimeline,
  PullRequestTimelineCommentLocation,
  PullRequestTimelineError,
  PullRequestTimelineErrorKind,
  PullRequestTimelineItem,
  PullRequestTimelineReviewState,
  SearchIssuesAndPrsOptions,
  SearchResult,
} from "./forge-service.js";
export type { GitHubPullRequestStatusFacts } from "./github-facts.js";

const DEFAULT_GITHUB_CACHE_TTL_MS = 30_000;
const CHECK_ANNOTATION_PAGE_MAX = 20;
const CHECK_LOG_TAIL_MAX_LINES = 200;
const CHECK_LOG_TAIL_MAX_BYTES = 16 * 1024;
const CHECK_LOG_TAIL_CACHE_MAX_ENTRIES = 128;
const ACTIONS_JOB_PAGE_MAX = 100;
const FAILED_CHECK_JOB_LIMIT = 5;
export const GITHUB_POLL_FAST_INTERVAL_MS = 20_000;
export const GITHUB_POLL_SLOW_INTERVAL_MS = 120_000;
export const GITHUB_POLL_ERROR_BACKOFF_CAP_MS = 300_000;
// The PR status poller batches every due target into aliased GraphQL queries
// instead of one `gh pr view` + facts query per workspace. Cost scales with the
// GraphQL point budget (5,000/hour), so the batch size and the shared poll time
// grid below exist to keep a many-workspace daemon from exhausting the quota
// machine-wide (issues #3587 / #2470).
export const GITHUB_POLL_BATCH_MAX = 25;
export const GITHUB_POLL_ALIGNMENT_MS = 5_000;
const GITHUB_GRAPHQL_RESERVE_RATIO = 0.4;
const GITHUB_GRAPHQL_RESET_GRACE_MS = 1_000;
const BATCH_PR_CANDIDATE_LIMIT = 10;
const FROZEN_PR_CHECKS_CACHE_MAX_ENTRIES = 512;
const GITHUB_ENV = {
  GIT_TERMINAL_PROMPT: "0",
} as const;
// Matches the glab/tea adapters' command timeout so a hung `gh` invocation
// (e.g. a stalled network call) fails the same way across every forge.
const GITHUB_COMMAND_TIMEOUT_MS = 30_000;
const REPO_HOST_NULL_TTL_MS = 60_000;
const GIT_ORIGIN_URL_READ_TIMEOUT_MS = 5_000;

const LabelSchema = z.object({
  name: z.string().optional(),
});

const GitHubIssueSummarySchema = z.object({
  number: z.number(),
  title: z.string().catch(""),
  url: z.string().catch(""),
  state: z.string().catch(""),
  body: z.string().nullable().catch(null),
  labels: z.array(LabelSchema).catch([]),
  updatedAt: z.string().catch(""),
});

const GitHubPullRequestSummarySchema = z.object({
  number: z.number(),
  title: z.string().catch(""),
  url: z.string().catch(""),
  state: z.string().catch(""),
  body: z.string().nullable().catch(null),
  baseRefName: z.string().catch(""),
  headRefName: z.string().catch(""),
  labels: z.array(LabelSchema).catch([]),
  updatedAt: z.string().catch(""),
});

const GitHubRepositoryListItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  nameWithOwner: z.string(),
  description: z.string().nullable().optional(),
  isPrivate: z.boolean(),
  updatedAt: z.string(),
  sshUrl: z.string(),
  url: z.string(),
});

const GitHubRepositorySearchItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  fullName: z.string(),
  description: z.string().nullable().optional(),
  isPrivate: z.boolean(),
  updatedAt: z.string(),
  url: z.string(),
});

const PullRequestCheckRunNodeSchema = z.object({
  __typename: z.literal("CheckRun"),
  databaseId: z.number().nullable().optional(),
  name: z.string(),
  workflowName: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  checkSuite: z
    .object({
      workflowRun: z
        .object({
          databaseId: z.number().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const PullRequestStatusContextNodeSchema = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string(),
  state: z.string().nullable().optional(),
  targetUrl: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});

const PullRequestStatusCheckRollupNodeSchema = z.discriminatedUnion("__typename", [
  PullRequestCheckRunNodeSchema,
  PullRequestStatusContextNodeSchema,
]);

const PullRequestStatusCheckRollupArraySchema = z.array(z.unknown());
const LegacyPullRequestStatusCheckRollupSchema = z.object({
  contexts: z.array(z.unknown()),
});

const GitHubCheckRunDetailsSchema = z.object({
  id: z.number(),
  name: z.string().catch(""),
  status: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  details_url: z.string().nullable().optional(),
  output: z
    .object({
      title: z.string().nullable().optional(),
      summary: z.string().nullable().optional(),
      text: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  check_suite: z
    .object({
      workflow_run: z
        .object({
          id: z.number().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const GitHubCheckAnnotationSchema = z.object({
  path: z.string().optional(),
  start_line: z.number().optional(),
  end_line: z.number().optional(),
  annotation_level: z.string().optional(),
  message: z.string().optional(),
  title: z.string().optional(),
  raw_details: z.string().optional(),
});

const GitHubCheckAnnotationsSchema = z.array(GitHubCheckAnnotationSchema).catch([]);

const GitHubActionsJobSchema = z.object({
  id: z.number(),
  name: z.string().catch(""),
  status: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});

const GitHubActionsJobsSchema = z.object({
  jobs: z.array(GitHubActionsJobSchema).catch([]),
});

const PullRequestReviewDecisionSchema = z
  .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
  .nullable()
  .catch(null);

const HeadRepositoryOwnerSchema = z
  .object({
    login: z.string().optional(),
  })
  .nullable()
  .optional();

const PullRequestMergeableSchema = z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).catch("UNKNOWN");

const GitHubAutoMergeRequestSchema = z
  .object({
    enabledAt: z.string().nullable().optional().catch(null),
    mergeMethod: z.string().nullable().optional().catch(null),
    enabledBy: z
      .object({
        login: z.string().nullable().optional().catch(null),
      })
      .nullable()
      .optional()
      .catch(null),
  })
  .nullable()
  .optional()
  .catch(null);

const GitHubPullRequestFactsGraphqlSchema = z.object({
  data: z.object({
    repository: z
      .object({
        autoMergeAllowed: z.boolean().optional().catch(false),
        mergeCommitAllowed: z.boolean().optional().catch(false),
        squashMergeAllowed: z.boolean().optional().catch(false),
        rebaseMergeAllowed: z.boolean().optional().catch(false),
        viewerDefaultMergeMethod: z.string().nullable().optional().catch(null),
        pullRequest: z
          .object({
            mergeStateStatus: z.string().nullable().optional().catch(null),
            autoMergeRequest: GitHubAutoMergeRequestSchema,
            viewerCanEnableAutoMerge: z.boolean().optional().catch(false),
            viewerCanDisableAutoMerge: z.boolean().optional().catch(false),
            viewerCanMergeAsAdmin: z.boolean().optional().catch(false),
            viewerCanUpdateBranch: z.boolean().optional().catch(false),
            isMergeQueueEnabled: z.boolean().optional().catch(false),
            isInMergeQueue: z.boolean().optional().catch(false),
          })
          .nullable()
          .optional()
          .catch(null),
      })
      .nullable()
      .optional()
      .catch(null),
  }),
});

const CurrentPullRequestStatusSchema = z.object({
  number: z.number().optional(),
  url: z.string().catch(""),
  title: z.string().catch(""),
  state: z.string().catch(""),
  isDraft: z.boolean().optional().catch(false),
  baseRefName: z.string().catch(""),
  headRefName: z.string().catch(""),
  headRefOid: z.string().optional(),
  mergedAt: z.string().nullable().optional(),
  statusCheckRollup: z.unknown().optional(),
  reviewDecision: z.unknown().optional(),
  mergeable: PullRequestMergeableSchema.optional().default("UNKNOWN"),
  headRepositoryOwner: HeadRepositoryOwnerSchema,
});

const TimelineAuthorSchema = z
  .object({
    login: z.string().optional(),
    url: z.string().nullable().optional(),
    avatarUrl: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const PullRequestTimelineReviewNodeSchema = z.object({
  id: z.string().catch(""),
  state: z.string().catch(""),
  body: z.string().nullable().catch(null),
  bodyHTML: z.string().nullable().catch(null),
  url: z.string().catch(""),
  submittedAt: z.string().nullable().catch(null),
  author: TimelineAuthorSchema,
});

const PullRequestTimelineCommentNodeSchema = z.object({
  id: z.string().catch(""),
  body: z.string().nullable().catch(null),
  bodyHTML: z.string().nullable().catch(null),
  url: z.string().catch(""),
  createdAt: z.string().nullable().catch(null),
  author: TimelineAuthorSchema,
});

const PullRequestReviewThreadCommentNodeSchema = PullRequestTimelineCommentNodeSchema.extend({
  pullRequestReview: z
    .object({ id: z.string().catch("") })
    .nullable()
    .optional()
    .catch(null),
});

const PullRequestReviewThreadNodeSchema = z.object({
  id: z.string().catch(""),
  path: z.string().catch(""),
  line: z.number().nullable().optional().catch(null),
  startLine: z.number().nullable().optional().catch(null),
  isResolved: z.boolean().catch(false),
  isOutdated: z.boolean().catch(false),
  comments: z
    .object({
      nodes: z.array(PullRequestReviewThreadCommentNodeSchema).catch([]),
      pageInfo: z.object({ hasNextPage: z.boolean().catch(false) }).catch({ hasNextPage: false }),
    })
    .catch({ nodes: [], pageInfo: { hasNextPage: false } }),
});

const PullRequestTimelinePageInfoSchema = z.object({
  hasNextPage: z.boolean().catch(false),
});

const PullRequestTimelineGraphqlSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              number: z.number().optional(),
              reviews: z
                .object({
                  nodes: z.array(PullRequestTimelineReviewNodeSchema).catch([]),
                  pageInfo: PullRequestTimelinePageInfoSchema.catch({ hasNextPage: false }),
                })
                .catch({ nodes: [], pageInfo: { hasNextPage: false } }),
              comments: z
                .object({
                  nodes: z.array(PullRequestTimelineCommentNodeSchema).catch([]),
                  pageInfo: PullRequestTimelinePageInfoSchema.catch({ hasNextPage: false }),
                })
                .catch({ nodes: [], pageInfo: { hasNextPage: false } }),
              reviewThreads: z
                .object({
                  nodes: z.array(PullRequestReviewThreadNodeSchema).catch([]),
                  pageInfo: PullRequestTimelinePageInfoSchema.catch({ hasNextPage: false }),
                })
                .catch({ nodes: [], pageInfo: { hasNextPage: false } }),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

const GitHubRepoViewSchema = z.object({
  owner: z
    .object({
      login: z.string().optional(),
    })
    .nullable()
    .optional(),
  name: z.string().optional(),
  parent: z
    .object({
      owner: z
        .object({
          login: z.string().optional(),
        })
        .nullable()
        .optional(),
      name: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const PullRequestCheckoutTargetSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z
        .object({
          number: z.number(),
          baseRefName: z.string().catch(""),
          headRefName: z.string().catch(""),
          isCrossRepository: z.boolean().catch(false),
          headRepositoryOwner: z
            .object({
              login: z.string().catch(""),
            })
            .nullable()
            .optional(),
          headRepository: z
            .object({
              sshUrl: z.string().nullable().optional(),
              url: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable(),
    }),
  }),
});

const PULL_REQUEST_CHECKOUT_TARGET_QUERY = `
query PullRequestCheckoutTarget($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      baseRefName
      headRefName
      isCrossRepository
      headRepositoryOwner {
        login
      }
      headRepository {
        sshUrl
        url
      }
    }
  }
}`;

const CURRENT_PR_STATUS_BASE_FIELDS =
  "number,url,title,state,isDraft,baseRefName,headRefName,headRefOid,mergedAt,reviewDecision,mergeable,headRepositoryOwner";
const CURRENT_PR_STATUS_FIELDS = `${CURRENT_PR_STATUS_BASE_FIELDS},statusCheckRollup`;

const PULL_REQUEST_STATUS_FACTS_QUERY = `
query PullRequestStatusFacts($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    autoMergeAllowed
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    viewerDefaultMergeMethod
    pullRequest(number: $number) {
      mergeStateStatus
      autoMergeRequest {
        enabledAt
        mergeMethod
        enabledBy {
          login
        }
      }
      viewerCanEnableAutoMerge
      viewerCanDisableAutoMerge
      viewerCanMergeAsAdmin
      viewerCanUpdateBranch
      isMergeQueueEnabled
      isInMergeQueue
    }
  }
}`;

const PULL_REQUEST_TIMELINE_QUERY = `
query PullRequestTimeline($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      reviews(first: 100) {
        nodes {
          id
          state
          body
          bodyHTML
          url
          submittedAt
          author {
            login
            url
            avatarUrl
          }
        }
        pageInfo {
          hasNextPage
        }
      }
      comments(first: 100) {
        nodes {
          id
          body
          bodyHTML
          url
          createdAt
          author {
            login
            url
            avatarUrl
          }
        }
        pageInfo {
          hasNextPage
        }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          path
          line
          startLine
          isResolved
          isOutdated
          comments(first: 100) {
            nodes {
              id
              body
              bodyHTML
              url
              createdAt
              author {
                login
                url
                avatarUrl
              }
              pullRequestReview {
                id
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
}`;

const BatchPollPrNodeSchema = z.object({
  number: z.number(),
  url: z.string().catch(""),
  title: z.string().catch(""),
  state: z.string().catch(""),
  isDraft: z.boolean().optional().catch(false),
  baseRefName: z.string().catch(""),
  headRefName: z.string().catch(""),
  headRefOid: z.string().catch(""),
  mergedAt: z.string().nullable().optional(),
  mergeable: PullRequestMergeableSchema.optional().default("UNKNOWN"),
  reviewDecision: z.unknown().optional(),
  headRepositoryOwner: HeadRepositoryOwnerSchema,
  mergeStateStatus: z.string().nullable().optional().catch(null),
  autoMergeRequest: GitHubAutoMergeRequestSchema,
  viewerCanEnableAutoMerge: z.boolean().optional().catch(false),
  viewerCanDisableAutoMerge: z.boolean().optional().catch(false),
  viewerCanMergeAsAdmin: z.boolean().optional().catch(false),
  viewerCanUpdateBranch: z.boolean().optional().catch(false),
  isMergeQueueEnabled: z.boolean().optional().catch(false),
  isInMergeQueue: z.boolean().optional().catch(false),
});

const BatchPollRepositorySchema = z.object({
  owner: z.object({ login: z.string().optional() }).nullable().optional().catch(null),
  isFork: z.boolean().optional().catch(false),
  parent: z
    .object({ owner: z.object({ login: z.string() }), name: z.string() })
    .nullable()
    .optional()
    .catch(null),
  autoMergeAllowed: z.boolean().optional().catch(false),
  mergeCommitAllowed: z.boolean().optional().catch(false),
  squashMergeAllowed: z.boolean().optional().catch(false),
  rebaseMergeAllowed: z.boolean().optional().catch(false),
  viewerDefaultMergeMethod: z.string().nullable().optional().catch(null),
  pullRequests: z.object({ nodes: z.array(BatchPollPrNodeSchema) }),
});

const GitHubGraphqlRateLimitSchema = z.object({
  limit: z.number(),
  remaining: z.number(),
  resetAt: z.string(),
});

const GitHubRateLimitResponseSchema = z.object({
  resources: z.object({
    graphql: z.object({
      remaining: z.number(),
      reset: z.number(),
    }),
  }),
});

const BatchChecksCommitSchema = z.object({
  commit: z.object({
    statusCheckRollup: z
      .object({
        contexts: z.object({ nodes: z.array(z.unknown()) }),
      })
      .nullable()
      .optional(),
  }),
});

const BatchChecksRepositorySchema = z.object({
  pullRequest: z
    .object({
      commits: z.object({ nodes: z.array(BatchChecksCommitSchema) }),
    })
    .nullable(),
});

// GraphQL CheckRun nodes carry the workflow name behind
// checkSuite.workflowRun.workflow.name; the gh CLI flattens it to workflowName.
// Batch results are remapped to the CLI shape so parseStatusCheckRollup stays
// the single rollup parser for both paths.
const BatchCheckRunContextSchema = z.object({
  __typename: z.literal("CheckRun"),
  databaseId: z.number().nullable().optional(),
  name: z.string(),
  status: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  checkSuite: z
    .object({
      workflowRun: z
        .object({
          databaseId: z.number().nullable().optional(),
          workflow: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

type BatchPollPrNode = z.infer<typeof BatchPollPrNodeSchema>;
type BatchPollRepository = z.infer<typeof BatchPollRepositorySchema>;

const BATCH_PR_STATUS_FRAGMENT = `
fragment PaseoPollPullRequest on PullRequest {
  number
  url
  title
  state
  isDraft
  baseRefName
  headRefName
  headRefOid
  mergedAt
  mergeable
  reviewDecision
  headRepositoryOwner {
    login
  }
  mergeStateStatus
  autoMergeRequest {
    enabledAt
    mergeMethod
    enabledBy {
      login
    }
  }
  viewerCanEnableAutoMerge
  viewerCanDisableAutoMerge
  viewerCanMergeAsAdmin
  viewerCanUpdateBranch
  isMergeQueueEnabled
  isInMergeQueue
}`;

function batchAlias(index: number): string {
  return `t${index}`;
}

// GraphQL string literals share JSON's escaping rules.
function graphqlString(value: string): string {
  return JSON.stringify(value);
}

function buildBatchPullRequestStatusQuery(
  entries: Array<{ owner: string; name: string; headRef: string }>,
): string {
  const aliases = entries.map(
    (entry, index) => `  ${batchAlias(index)}: repository(owner: ${graphqlString(
      entry.owner,
    )}, name: ${graphqlString(entry.name)}) {
    owner {
      login
    }
    isFork
    parent {
      owner {
        login
      }
      name
    }
    autoMergeAllowed
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    viewerDefaultMergeMethod
    pullRequests(headRefName: ${graphqlString(
      entry.headRef,
    )}, first: ${BATCH_PR_CANDIDATE_LIMIT}, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        ...PaseoPollPullRequest
      }
    }
  }`,
  );
  return `query PaseoBatchPullRequestStatus {
  rateLimit {
    limit
    remaining
    resetAt
  }
${aliases.join("\n")}
}\n${BATCH_PR_STATUS_FRAGMENT}`;
}

function buildBatchPullRequestChecksQuery(
  entries: Array<{ owner: string; name: string; number: number }>,
): string {
  const aliases = entries.map(
    (entry, index) => `  ${batchAlias(index)}: repository(owner: ${graphqlString(
      entry.owner,
    )}, name: ${graphqlString(entry.name)}) {
    pullRequest(number: ${entry.number}) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    status
                    conclusion
                    detailsUrl
                    startedAt
                    completedAt
                    checkSuite {
                      workflowRun {
                        databaseId
                        workflow {
                          name
                        }
                      }
                    }
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    }
  }`,
  );
  return `query PaseoBatchPullRequestChecks {
  rateLimit {
    limit
    remaining
    resetAt
  }
${aliases.join("\n")}
}`;
}

function toBatchStatusCheckRollupNode(node: unknown): unknown {
  const parsed = BatchCheckRunContextSchema.safeParse(node);
  if (!parsed.success) {
    // StatusContext nodes already match the CLI rollup shape.
    return node;
  }
  const { checkSuite, ...rest } = parsed.data;
  return {
    ...rest,
    workflowName: checkSuite?.workflowRun?.workflow?.name ?? null,
    checkSuite: { workflowRun: { databaseId: checkSuite?.workflowRun?.databaseId ?? null } },
  };
}

function extractGraphqlBatchAliases(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object") {
    return null;
  }
  return data as Record<string, unknown>;
}

function parseGraphqlBatchAliases(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "{}");
  } catch {
    return {};
  }
  return extractGraphqlBatchAliases(parsed) ?? {};
}

// gh exits non-zero when any aliased sub-query errors but still prints the
// response body, so the healthy aliases in a batch are recoverable.
function extractGraphqlBatchAliasesFromError(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof GitHubCommandError) || !error.stdout) {
    return null;
  }
  try {
    return extractGraphqlBatchAliases(JSON.parse(error.stdout));
  } catch {
    return null;
  }
}

function parseGraphqlBatchRateLimit(
  stdout: string,
): z.infer<typeof GitHubGraphqlRateLimitSchema> | null {
  try {
    const aliases = extractGraphqlBatchAliases(JSON.parse(stdout));
    const parsed = GitHubGraphqlRateLimitSchema.safeParse(aliases?.rateLimit);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  cwd: string;
}

interface GitHubServiceDependencies {
  runner: GitHubCommandRunner;
  resolveGhPath: () => Promise<string | null>;
  now: () => number;
  /**
   * GitHub Enterprise host for a workspace, or null for github.com (where `gh`
   * already defaults correctly). Used to set GH_HOST so every `gh api`/`graphql`
   * call routes to the workspace's instance instead of github.com.
   */
  resolveRepoHost: (cwd: string) => Promise<string | null>;
  /**
   * owner/name slug for a workspace, resolved offline from the origin remote.
   * Batched PR status polls need the repository identity up front (GraphQL
   * repository(owner:, name:) aliases), unlike `gh pr view` which resolves it
   * per invocation.
   */
  resolveRepoSlug: (cwd: string) => Promise<string | null>;
}

export interface GitHubCommandRunnerOptions {
  cwd: string;
  envOverlay?: Record<string, string>;
}

export interface GitHubCommandResult {
  stdout: string;
  stderr: string;
}

export type GitHubCommandRunner = (
  args: string[],
  options: GitHubCommandRunnerOptions,
) => Promise<GitHubCommandResult>;

const DIRECT_PULL_REQUEST_MERGE_STATE_ALLOWLIST = new Set(["CLEAN", "HAS_HOOKS"]);

export interface GitHubRepositorySummary {
  id: string;
  name: string;
  nameWithOwner: string;
  description: string | null;
  visibility: "public" | "private" | "internal";
  updatedAt: string;
  cloneUrl: string;
}

export interface SearchGitHubRepositoriesOptions {
  cwd: string;
  query: string;
  limit?: number;
}

export interface GitHubService extends ForgeService {
  searchRepositories(options: SearchGitHubRepositoriesOptions): Promise<GitHubRepositorySummary[]>;
}

export class GitHubCliMissingError extends ForgeCliMissingError {
  constructor() {
    super("GitHub CLI (gh) is not installed or not in PATH");
    this.name = "GitHubCliMissingError";
  }
}

export class GitHubAuthenticationError extends ForgeAuthenticationError {
  constructor(params: { stderr: string }) {
    super("GitHub CLI authentication failed", params);
    this.name = "GitHubAuthenticationError";
  }
}

export class GitHubCommandError extends ForgeCommandError {
  constructor(params: ForgeCommandFailureParams) {
    super({ brand: "GitHub", binary: "gh" }, params);
    this.name = "GitHubCommandError";
  }
}

class GitHubGraphqlPollPausedError extends Error {
  readonly remaining: number;
  readonly resetAt: string;

  constructor(params: { remaining: number; resetAt: string }) {
    super(`GitHub GraphQL polling paused until ${params.resetAt}`);
    this.name = "GitHubGraphqlPollPausedError";
    this.remaining = params.remaining;
    this.resetAt = params.resetAt;
  }
}

export class GitHubEnterpriseHostProbeError extends Error {
  readonly host: string;
  override readonly cause: Error;

  constructor(params: { host: string; cause: Error }) {
    super(`Unable to verify GitHub Enterprise host ${params.host}`);
    this.name = "GitHubEnterpriseHostProbeError";
    this.host = params.host;
    this.cause = params.cause;
  }
}

interface CreateGitHubServiceOptions {
  ttlMs?: number;
  runner?: GitHubCommandRunner;
  resolveGhPath?: () => Promise<string | null>;
  now?: () => number;
  resolveRepoHost?: (cwd: string) => Promise<string | null>;
  resolveRepoSlug?: (cwd: string) => Promise<string | null>;
}

type PullRequestCheckRunNode = z.infer<typeof PullRequestCheckRunNodeSchema>;
type PullRequestStatusContextNode = z.infer<typeof PullRequestStatusContextNodeSchema>;
type CurrentPullRequestStatusItem = z.infer<typeof CurrentPullRequestStatusSchema>;
type GitHubPullRequestFactsGraphql = z.infer<typeof GitHubPullRequestFactsGraphqlSchema>;
type GitHubPullRequestFactsRepository = NonNullable<
  GitHubPullRequestFactsGraphql["data"]["repository"]
>;
type GitHubPullRequestFactsPullRequest = NonNullable<
  GitHubPullRequestFactsRepository["pullRequest"]
>;

interface InFlightCacheEntry {
  cwd: string;
  promise: Promise<unknown>;
  force: boolean;
}

interface GitHubPollTarget {
  cwd: string;
  headRef: string;
  headSha?: string;
  headRepositoryOwner?: string;
  retainCount: number;
  /** Absolute due time on the shared poll grid; null while a poll is in flight. */
  nextDueAt: number | null;
  /**
   * When the in-flight poll cycle became due. The next cycle is anchored here
   * rather than at completion time so slow requests don't drift the poll grid.
   */
  pollCycleStartedAt: number | null;
  latestStatus: CurrentPullRequestStatus | null;
  consecutiveErrors: number;
  callbacks: Set<(status: CurrentPullRequestStatus | null) => void>;
  errorCallbacks: Set<(error: unknown) => void>;
}

interface GitHubBatchPollEntry {
  target: GitHubPollTarget;
  host: string;
  originOwner: string;
  originName: string;
  owner: string;
  name: string;
  headRepositoryOwner?: string;
}

interface PendingBatchPullRequestChecks {
  entry: GitHubBatchPollEntry;
  node: BatchPollPrNode;
  repository: BatchPollRepository;
  /** Frozen-checks cache key for non-open PRs, or null when checks may still change. */
  cacheKey: string | null;
}

interface GitHubBatchQueryResponse {
  aliases: Record<string, unknown>;
  stdout: string;
}

interface GitHubBatchDistribution {
  pendingChecks: PendingBatchPullRequestChecks[];
  legacyFallback: GitHubPollTarget[];
  redirected: GitHubBatchPollEntry[];
}

interface ResolvedPullRequestCandidate {
  status: CurrentPullRequestStatus;
  headSha?: string;
  headRepositoryOwner?: string;
}

export function createGitHubService(options: CreateGitHubServiceOptions = {}): GitHubService {
  const ttlMs = options.ttlMs ?? DEFAULT_GITHUB_CACHE_TTL_MS;
  const deps: GitHubServiceDependencies = {
    runner: options.runner ?? runGhCommand,
    resolveGhPath: options.resolveGhPath ?? resolveGhPath,
    now: options.now ?? Date.now,
    resolveRepoHost: options.resolveRepoHost ?? resolveGitHubEnterpriseHost,
    resolveRepoSlug: options.resolveRepoSlug ?? resolveGitHubSlugFromOrigin,
  };
  // A resolved enterprise host is cached permanently; a null resolution (no
  // host, or the auth probe said no) expires so `gh auth login --hostname`
  // run after the first probe is picked up without a daemon restart. The
  // `resolved` marker survives a TTL refresh so poll batching can keep using
  // the last known host synchronously while the refresh is in flight.
  const repoHostByCwd = new Map<
    string,
    {
      promise: Promise<string | null>;
      expiresAt: number | null;
      resolved?: { value: string | null };
    }
  >();
  // owner/name from the origin remote, cached until invalidate() (which fires
  // on remote changes) so batched polls can group targets synchronously. Null
  // resolutions expire like the host cache's so transient git failures don't
  // permanently degrade a cwd to per-target polling.
  const repoSlugByCwd = new Map<
    string,
    {
      promise: Promise<string | null>;
      expiresAt: number | null;
      resolved?: { value: string | null };
    }
  >();
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, InFlightCacheEntry>();
  const pollTargets = new Map<string, GitHubPollTarget>();
  const checkLogTailCache = new Map<string, { logTail: string; logTruncated: boolean }>();
  // Rollup nodes for merged/closed PRs keyed by repo#number@headOid: their
  // checks can no longer change, so each is fetched at most once per daemon run.
  const frozenPullRequestChecksCache = new Map<string, unknown[]>();
  const pollRepositoryRedirects = new Map<
    string,
    { owner: string; name: string; headRepositoryOwner: string }
  >();
  const pollPausedUntilByHost = new Map<string, number>();
  const rateLimitResetLoads = new Map<string, Promise<number | null>>();
  let githubPollTimer: NodeJS.Timeout | null = null;
  let api!: GitHubService;

  async function cached<T>(params: {
    cwd: string;
    method: string;
    args: unknown;
    readOptions?: ForgeReadOptions;
    load: () => Promise<T>;
  }): Promise<T> {
    if (params.readOptions?.force && !params.readOptions.reason) {
      throw new Error("ForgeService forced read requires a reason");
    }

    const key = buildCacheKey({
      cwd: params.cwd,
      method: params.method,
      args: params.args,
    });
    const cachedEntry = cache.get(key);
    const now = deps.now();
    if (!params.readOptions?.force && cachedEntry && cachedEntry.expiresAt > now) {
      return cachedEntry.value as T;
    }

    const existing = inFlight.get(key);
    if (existing && (!params.readOptions?.force || existing.force)) {
      return existing.promise as Promise<T>;
    }

    const request = params
      .load()
      .then((value) => {
        if (inFlight.get(key)?.promise === request) {
          cache.set(key, {
            value,
            cwd: params.cwd,
            expiresAt: deps.now() + ttlMs,
          });
        }
        return value;
      })
      .finally(() => {
        if (inFlight.get(key)?.promise === request) {
          inFlight.delete(key);
        }
      });
    inFlight.set(key, {
      cwd: params.cwd,
      promise: request,
      force: params.readOptions?.force === true,
    });
    return request;
  }

  function resolveRepoHostCached(cwd: string): Promise<string | null> {
    const cachedHost = repoHostByCwd.get(cwd);
    if (cachedHost && (cachedHost.expiresAt === null || deps.now() < cachedHost.expiresAt)) {
      return cachedHost.promise;
    }
    const pending = deps
      .resolveRepoHost(cwd)
      .then((host) => {
        const current = repoHostByCwd.get(cwd);
        if (current?.promise === pending) {
          current.resolved = { value: host };
          if (host === null) {
            current.expiresAt = deps.now() + REPO_HOST_NULL_TTL_MS;
          }
        }
        return host;
      })
      .catch((error: unknown) => {
        if (repoHostByCwd.get(cwd)?.promise === pending) {
          repoHostByCwd.delete(cwd);
        }
        throw error;
      });
    repoHostByCwd.set(cwd, {
      promise: pending,
      expiresAt: null,
      ...(cachedHost?.resolved ? { resolved: cachedHost.resolved } : {}),
    });
    return pending;
  }

  function peekRepoHost(cwd: string): { settled: boolean; value: string | null } {
    const entry = repoHostByCwd.get(cwd);
    if (!entry) {
      void resolveRepoHostCached(cwd).catch(() => {});
      return { settled: false, value: null };
    }
    return entry.resolved
      ? { settled: true, value: entry.resolved.value }
      : { settled: false, value: null };
  }

  function resolveRepoSlugCached(cwd: string): Promise<string | null> {
    const cachedSlug = repoSlugByCwd.get(cwd);
    if (cachedSlug && (cachedSlug.expiresAt === null || deps.now() < cachedSlug.expiresAt)) {
      return cachedSlug.promise;
    }
    // A null slug expires: resolveRepoSlug also returns null for transient git
    // failures (lock contention, timeout), and a permanent null would silently
    // pin this cwd to the legacy per-target poll path. The `resolved` marker
    // survives the refresh so batching keeps the last known slug meanwhile.
    const entry: {
      promise: Promise<string | null>;
      expiresAt: number | null;
      resolved?: { value: string | null };
    } = {
      promise: deps
        .resolveRepoSlug(cwd)
        .then((slug) => {
          if (repoSlugByCwd.get(cwd) === entry) {
            entry.resolved = { value: slug };
            if (slug === null) {
              entry.expiresAt = deps.now() + REPO_HOST_NULL_TTL_MS;
            }
          }
          return slug;
        })
        .catch(() => {
          if (repoSlugByCwd.get(cwd) === entry) {
            entry.resolved = { value: null };
            entry.expiresAt = deps.now() + REPO_HOST_NULL_TTL_MS;
          }
          return null;
        }),
      expiresAt: null,
      ...(cachedSlug?.resolved ? { resolved: cachedSlug.resolved } : {}),
    };
    repoSlugByCwd.set(cwd, entry);
    return entry.promise;
  }

  function peekRepoSlug(cwd: string): { settled: boolean; value: string | null } {
    const entry = repoSlugByCwd.get(cwd);
    if (!entry) {
      void resolveRepoSlugCached(cwd);
      return { settled: false, value: null };
    }
    return entry.resolved
      ? { settled: true, value: entry.resolved.value }
      : { settled: false, value: null };
  }

  async function run(args: string[], runOptions: GitHubCommandRunnerOptions): Promise<string> {
    const ghPath = await deps.resolveGhPath();
    if (!ghPath) {
      throw new GitHubCliMissingError();
    }
    // Route every gh invocation to the workspace's host. `gh api`/`graphql`
    // otherwise default to github.com regardless of the resolved repository,
    // which silently queries the wrong server on GitHub Enterprise. GH_HOST is
    // safe even for auto-routing subcommands because it matches the repo's host.
    const host = await resolveRepoHostCached(runOptions.cwd);
    const effectiveOptions: GitHubCommandRunnerOptions = host
      ? { ...runOptions, envOverlay: { ...runOptions.envOverlay, GH_HOST: host } }
      : runOptions;
    try {
      const result = await deps.runner(args, effectiveOptions);
      return result.stdout.trim();
    } catch (error) {
      throw githubCliRunner.normalizeError(error, {
        args,
        cwd: runOptions.cwd,
      });
    }
  }

  async function runGhJson<T>(
    args: string[],
    runOptions: GitHubCommandRunnerOptions,
    schema: z.ZodType<T>,
    emptyFallback: string,
  ): Promise<T> {
    const stdout = await run(args, runOptions);
    return parseGitHubJsonOutput(stdout, schema, {
      args,
      cwd: runOptions.cwd,
      emptyFallback,
    });
  }

  function getPollTargetKey(target: {
    cwd: string;
    headRef: string;
    headSha?: string;
    headRepositoryOwner?: string;
  }): string {
    return buildCacheKey({
      cwd: target.cwd,
      method: "getCurrentPullRequestStatus",
      args: {
        headRef: target.headRef,
        headSha: target.headSha,
        headRepositoryOwner: target.headRepositoryOwner,
      },
    });
  }

  function updatePollTargetAfterSuccess(update: {
    cwd: string;
    headRef: string;
    headSha?: string;
    headRepositoryOwner?: string;
    status: CurrentPullRequestStatus | null;
    notify: boolean;
  }): void {
    const target = pollTargets.get(getPollTargetKey(update));
    if (!target) {
      return;
    }

    target.latestStatus = update.status;
    target.consecutiveErrors = 0;
    if (update.notify) {
      for (const callback of target.callbacks) {
        callback(update.status);
      }
    }
    scheduleGitHubPoll(target);
  }

  function scheduleGitHubPoll(target: GitHubPollTarget): void {
    scheduleGitHubPollAfter(
      target,
      computeGithubNextInterval(target.latestStatus, target.consecutiveErrors),
    );
  }

  function scheduleImmediateGitHubPoll(target: GitHubPollTarget): void {
    scheduleGitHubPollAfter(target, 0);
  }

  function scheduleGitHubPollAfter(target: GitHubPollTarget, delayMs: number): void {
    if (target.retainCount <= 0) {
      return;
    }
    const now = deps.now();
    const baseline = target.pollCycleStartedAt ?? now;
    target.pollCycleStartedAt = null;
    const pauseUntil = getPollPauseUntil(target.cwd);
    if (delayMs <= 0) {
      target.nextDueAt = Math.max(now, pauseUntil);
      armGitHubPollTimer();
      return;
    }
    // Non-immediate polls snap to a shared time grid so targets converge on the
    // same tick and one batched GraphQL request covers all of them. The next
    // cycle anchors at the previous cycle's due time so slow requests don't
    // drift the grid — but when the cycle overran its slot entirely, re-anchor
    // at completion: scheduling in the past would poll back-to-back precisely
    // when GitHub is slow or erroring.
    const dueAt = alignGitHubPollTime(baseline + delayMs);
    const nextDueAt = dueAt >= now ? dueAt : alignGitHubPollTime(now + delayMs);
    target.nextDueAt = Math.max(nextDueAt, pauseUntil);
    armGitHubPollTimer();
  }

  function getPollPauseUntil(cwd: string): number {
    const host = peekRepoHost(cwd);
    if (!host.settled) {
      return 0;
    }
    const key = host.value ?? "";
    const pauseUntil = pollPausedUntilByHost.get(key) ?? 0;
    if (pauseUntil <= deps.now()) {
      pollPausedUntilByHost.delete(key);
      return 0;
    }
    return pauseUntil;
  }

  function alignGitHubPollTime(dueAt: number): number {
    return Math.ceil(dueAt / GITHUB_POLL_ALIGNMENT_MS) * GITHUB_POLL_ALIGNMENT_MS;
  }

  function armGitHubPollTimer(): void {
    let earliest: number | null = null;
    for (const target of pollTargets.values()) {
      if (target.retainCount <= 0 || target.nextDueAt === null) {
        continue;
      }
      if (earliest === null || target.nextDueAt < earliest) {
        earliest = target.nextDueAt;
      }
    }
    if (githubPollTimer) {
      clearTimeout(githubPollTimer);
      githubPollTimer = null;
    }
    if (earliest === null) {
      return;
    }
    githubPollTimer = setTimeout(
      () => {
        githubPollTimer = null;
        void flushDueGitHubPolls();
      },
      Math.max(0, earliest - deps.now()),
    );
  }

  async function flushDueGitHubPolls(): Promise<void> {
    const now = deps.now();
    const due: GitHubPollTarget[] = [];
    for (const target of pollTargets.values()) {
      if (target.retainCount > 0 && target.nextDueAt !== null && target.nextDueAt <= now) {
        target.nextDueAt = null;
        target.pollCycleStartedAt = now;
        due.push(target);
      }
    }
    armGitHubPollTimer();
    if (due.length === 0) {
      return;
    }

    const legacyTargets: GitHubPollTarget[] = [];
    const batchGroups = new Map<string, GitHubBatchPollEntry[]>();
    for (const target of due) {
      if (target.retainCount <= 0) {
        continue;
      }
      const host = peekRepoHost(target.cwd);
      const slug = peekRepoSlug(target.cwd);
      if (!host.settled || !slug.settled) {
        target.pollCycleStartedAt = null;
        void Promise.all([
          resolveRepoHostCached(target.cwd).catch(() => null),
          resolveRepoSlugCached(target.cwd),
        ]).then(() => {
          if (target.retainCount > 0 && target.nextDueAt === null) {
            // A non-zero delay rejoins the shared polling grid.
            scheduleGitHubPollAfter(target, 1);
          }
          return undefined;
        });
        continue;
      }
      const [owner, name, extra] = slug.value?.split("/") ?? [];
      // A cwd with no origin slug polls through the legacy per-target path;
      // batch grouping needs a complete owner/name identity.
      if (!owner || !name || extra !== undefined) {
        legacyTargets.push(target);
        continue;
      }
      const key = host.value ?? "";
      const group = batchGroups.get(key) ?? [];
      group.push({
        target,
        host: key,
        originOwner: owner,
        originName: name,
        owner,
        name,
      });
      batchGroups.set(key, group);
    }

    await Promise.all([
      ...legacyTargets.map((target) => runGitHubPoll(target)),
      ...[...batchGroups.values()].map((group) => runGitHubPollGroup(group, now)),
    ]);
  }

  async function runGitHubPollGroup(
    entries: GitHubBatchPollEntry[],
    startedAt: number,
  ): Promise<void> {
    for (let start = 0; start < entries.length; start += GITHUB_POLL_BATCH_MAX) {
      const chunk = entries.slice(start, start + GITHUB_POLL_BATCH_MAX);
      if ((pollPausedUntilByHost.get(chunk[0]?.host ?? "") ?? 0) > deps.now()) {
        return;
      }
      await runGitHubPollBatch(chunk, startedAt);
    }
  }

  function pauseGitHubPollsAtReserve(
    host: string,
    rateLimit: z.infer<typeof GitHubGraphqlRateLimitSchema>,
  ): boolean {
    if (rateLimit.remaining > rateLimit.limit * GITHUB_GRAPHQL_RESERVE_RATIO) {
      return false;
    }
    const resetAt = Date.parse(rateLimit.resetAt);
    if (!Number.isFinite(resetAt)) {
      return false;
    }
    pauseGitHubPollHostUntil(host, resetAt + GITHUB_GRAPHQL_RESET_GRACE_MS);
    return true;
  }

  function pauseGitHubPollHostUntil(host: string, pauseUntil: number): void {
    if (pauseUntil <= deps.now()) {
      return;
    }
    const currentPause = pollPausedUntilByHost.get(host) ?? 0;
    pollPausedUntilByHost.set(host, Math.max(currentPause, pauseUntil));
    for (const target of pollTargets.values()) {
      const targetHost = peekRepoHost(target.cwd);
      if (!targetHost.settled || (targetHost.value ?? "") !== host) {
        continue;
      }
      target.pollCycleStartedAt = null;
      target.nextDueAt = Math.max(target.nextDueAt ?? 0, pauseUntil);
    }
    armGitHubPollTimer();
  }

  async function pauseGitHubPollsAfterRateLimit(
    entry: GitHubBatchPollEntry,
    error: unknown,
  ): Promise<boolean> {
    if (!isGitHubRateLimitError(error)) {
      return false;
    }
    const resetAt = await loadGitHubGraphqlResetAt(entry);
    if (resetAt === null) {
      return false;
    }
    pauseGitHubPollHostUntil(entry.host, resetAt + GITHUB_GRAPHQL_RESET_GRACE_MS);
    return true;
  }

  function loadGitHubGraphqlResetAt(entry: GitHubBatchPollEntry): Promise<number | null> {
    const existing = rateLimitResetLoads.get(entry.host);
    if (existing) {
      return existing;
    }
    const pending = runGhJson(
      ["api", "rate_limit"],
      { cwd: entry.target.cwd },
      GitHubRateLimitResponseSchema,
      "{}",
    )
      .then((response) => response.resources.graphql.reset * 1_000)
      .catch(() => null)
      .finally(() => {
        if (rateLimitResetLoads.get(entry.host) === pending) {
          rateLimitResetLoads.delete(entry.host);
        }
      });
    rateLimitResetLoads.set(entry.host, pending);
    return pending;
  }

  async function runGitHubPollBatch(
    entries: GitHubBatchPollEntry[],
    startedAt: number,
  ): Promise<void> {
    const addressedEntries = entries.map(addressGitHubBatchEntry);
    const firstEntry = addressedEntries[0];
    if (!firstEntry) {
      return;
    }
    const query = buildBatchPullRequestStatusQuery(
      addressedEntries.map((entry) => ({
        owner: entry.owner,
        name: entry.name,
        headRef: entry.target.headRef,
      })),
    );
    const args = ["api", "graphql", "-f", `query=${query}`];
    const response = await loadGitHubPollBatchResponse({
      entries: addressedEntries,
      firstEntry,
      args,
    });
    if (!response) {
      return;
    }
    const rateLimit = parseGraphqlBatchRateLimit(response.stdout);
    if (rateLimit && pauseGitHubPollsAtReserve(firstEntry.host, rateLimit)) {
      const error = new GitHubGraphqlPollPausedError(rateLimit);
      reportGitHubBatchError(addressedEntries, error);
      return;
    }

    const distribution = distributeGitHubPollBatch({
      entries: addressedEntries,
      aliases: response.aliases,
      args,
      startedAt,
    });
    if (distribution.pendingChecks.length > 0) {
      await loadBatchPullRequestChecks(distribution.pendingChecks, startedAt);
    }
    await Promise.all(distribution.legacyFallback.map((target) => runGitHubPoll(target)));
    if (distribution.redirected.length > 0) {
      await runGitHubPollBatch(distribution.redirected, startedAt);
    }
  }

  async function loadGitHubPollBatchResponse(input: {
    entries: GitHubBatchPollEntry[];
    firstEntry: GitHubBatchPollEntry;
    args: string[];
  }): Promise<GitHubBatchQueryResponse | null> {
    try {
      const stdout = await run(input.args, { cwd: input.firstEntry.target.cwd });
      return { aliases: parseGraphqlBatchAliases(stdout), stdout };
    } catch (error) {
      const isPaused = await pauseGitHubPollsAfterRateLimit(input.firstEntry, error);
      const partial = extractGraphqlBatchAliasesFromError(error);
      if (isPaused || !partial) {
        reportGitHubBatchError(input.entries, error);
        return null;
      }
      const stdout = error instanceof GitHubCommandError ? (error.stdout ?? "") : "";
      return { aliases: partial, stdout };
    }
  }

  function reportGitHubBatchError(entries: GitHubBatchPollEntry[], error: unknown): void {
    for (const entry of entries) {
      updatePollTargetAfterError(entry.target, error);
    }
  }

  function distributeGitHubPollBatch(input: {
    entries: GitHubBatchPollEntry[];
    aliases: Record<string, unknown>;
    args: string[];
    startedAt: number;
  }): GitHubBatchDistribution {
    const distribution: GitHubBatchDistribution = {
      pendingChecks: [],
      legacyFallback: [],
      redirected: [],
    };
    for (const [index, entry] of input.entries.entries()) {
      const aliasValue = input.aliases[batchAlias(index)];
      const repository = aliasValue ? BatchPollRepositorySchema.safeParse(aliasValue) : null;
      if (!repository?.success) {
        updatePollTargetAfterError(
          entry.target,
          new GitHubCommandError({
            args: input.args,
            cwd: entry.target.cwd,
            exitCode: null,
            stderr: `GitHub batch PR status response is missing repository ${entry.owner}/${entry.name}`,
          }),
        );
        continue;
      }
      if (repository.data.isFork && repository.data.parent) {
        const forkOwner = repository.data.owner?.login ?? entry.owner;
        pollRepositoryRedirects.set(batchRepositoryRedirectKey(entry), {
          owner: repository.data.parent.owner.login,
          name: repository.data.parent.name,
          headRepositoryOwner: forkOwner,
        });
        distribution.redirected.push(entry);
        continue;
      }
      const node = selectBatchPollNode(entry, repository.data);
      if (!node) {
        // Legacy fallback covers the two ways "no match" can be wrong: a fork
        // whose PR lives in the parent repository, and a full candidate page —
        // ten newer same-named fork PRs can crowd the checkout's own PR out of
        // the first:N window, so absence is only conclusive on a partial page.
        if (
          repository.data.isFork ||
          repository.data.pullRequests.nodes.length >= BATCH_PR_CANDIDATE_LIMIT
        ) {
          distribution.legacyFallback.push(entry.target);
        } else {
          finalizeBatchPollTarget({
            entry,
            node: null,
            repository: repository.data,
            rollup: null,
            startedAt: input.startedAt,
          });
        }
        continue;
      }
      const frozenKey =
        node.state !== "OPEN" && node.headRefOid.length > 0
          ? `${entry.owner}/${entry.name}#${node.number}@${node.headRefOid}`
          : null;
      const cachedRollup = frozenKey ? frozenPullRequestChecksCache.get(frozenKey) : undefined;
      if (frozenKey && cachedRollup) {
        rememberFrozenPullRequestChecks(frozenKey, cachedRollup);
        finalizeBatchPollTarget({
          entry,
          node,
          repository: repository.data,
          rollup: cachedRollup,
          startedAt: input.startedAt,
        });
      } else {
        distribution.pendingChecks.push({
          entry,
          node,
          repository: repository.data,
          cacheKey: frozenKey,
        });
      }
    }
    return distribution;
  }

  function addressGitHubBatchEntry(entry: GitHubBatchPollEntry): GitHubBatchPollEntry {
    const redirect = pollRepositoryRedirects.get(batchRepositoryRedirectKey(entry));
    return redirect
      ? {
          ...entry,
          owner: redirect.owner,
          name: redirect.name,
          headRepositoryOwner: redirect.headRepositoryOwner,
        }
      : entry;
  }

  function batchRepositoryRedirectKey(entry: GitHubBatchPollEntry): string {
    return `${entry.host}\n${entry.originOwner}/${entry.originName}`;
  }

  function selectBatchPollNode(
    entry: GitHubBatchPollEntry,
    repository: BatchPollRepository,
  ): BatchPollPrNode | null {
    // Prefer the canonical owner from the response: the origin slug can carry
    // stale casing or a pre-transfer owner that repository() redirects from.
    const selfOwner = (repository.owner?.login ?? entry.owner).toLowerCase();
    const headRepositoryOwner = entry.target.headRepositoryOwner ?? entry.headRepositoryOwner;
    const nodeByCandidate = new Map<ResolvedPullRequestCandidate, BatchPollPrNode>();
    const candidates: ResolvedPullRequestCandidate[] = [];
    for (const node of repository.pullRequests.nodes) {
      const candidate = toCurrentPullRequestCandidate(
        toBatchCurrentPullRequestItem(node, undefined),
        entry.target.headRef,
      );
      if (!candidate) {
        continue;
      }
      // pullRequests(headRefName:) also matches forks whose branch shares the
      // name. Without a fork-owner hint the workspace branch lives in this
      // repository, so only self-owned heads are real candidates (mirrors
      // `gh pr view` resolving the current branch's own PR).
      if (!headRepositoryOwner && candidate.headRepositoryOwner?.toLowerCase() !== selfOwner) {
        continue;
      }
      nodeByCandidate.set(candidate, node);
      candidates.push(candidate);
    }
    const match = pickPullRequestCandidate({
      candidates,
      headRef: entry.target.headRef,
      headSha: entry.target.headSha,
      headRepositoryOwner,
    });
    return match ? (nodeByCandidate.get(match) ?? null) : null;
  }

  async function loadBatchPullRequestChecks(
    pending: PendingBatchPullRequestChecks[],
    startedAt: number,
  ): Promise<void> {
    const firstItem = pending[0];
    if (!firstItem) {
      return;
    }
    const query = buildBatchPullRequestChecksQuery(
      pending.map((item) => ({
        owner: item.entry.owner,
        name: item.entry.name,
        number: item.node.number,
      })),
    );
    const args = ["api", "graphql", "-f", `query=${query}`];
    let aliasData: Record<string, unknown>;
    let responseStdout: string;
    try {
      responseStdout = await run(args, { cwd: firstItem.entry.target.cwd });
      aliasData = parseGraphqlBatchAliases(responseStdout);
    } catch (error) {
      const isPaused = await pauseGitHubPollsAfterRateLimit(firstItem.entry, error);
      if (isPaused) {
        for (const item of pending) {
          updatePollTargetAfterError(item.entry.target, error);
        }
        return;
      }
      const partial = extractGraphqlBatchAliasesFromError(error);
      if (!partial) {
        for (const item of pending) {
          updatePollTargetAfterError(item.entry.target, error);
        }
        return;
      }
      aliasData = partial;
      responseStdout = error instanceof GitHubCommandError ? (error.stdout ?? "") : "";
    }

    const rateLimit = parseGraphqlBatchRateLimit(responseStdout);
    if (rateLimit) {
      pauseGitHubPollsAtReserve(firstItem.entry.host, rateLimit);
    }

    for (const [index, item] of pending.entries()) {
      const aliasValue = aliasData[batchAlias(index)];
      const parsed = aliasValue ? BatchChecksRepositorySchema.safeParse(aliasValue) : null;
      if (!parsed?.success || !parsed.data.pullRequest) {
        updatePollTargetAfterError(
          item.entry.target,
          new GitHubCommandError({
            args,
            cwd: item.entry.target.cwd,
            exitCode: null,
            stderr: `GitHub batch PR checks response is missing ${item.entry.owner}/${item.entry.name}#${item.node.number}`,
          }),
        );
        continue;
      }
      const contexts =
        parsed.data.pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
      const rollup = contexts.map(toBatchStatusCheckRollupNode);
      // Freeze only fully terminal rollups: a PR closed while CI is running
      // would otherwise pin "pending" checks (and the fast poll cadence) for
      // the daemon's lifetime. Reruns that flip a terminal check back to
      // pending on the same SHA are deliberately not tracked — stale terminal
      // checks on a closed/merged PR are cosmetic.
      const hasPendingChecks = parseStatusCheckRollup(rollup).some(
        (check) => check.status === "pending",
      );
      if (item.cacheKey && !hasPendingChecks) {
        rememberFrozenPullRequestChecks(item.cacheKey, rollup);
      }
      finalizeBatchPollTarget({
        entry: item.entry,
        node: item.node,
        repository: item.repository,
        rollup,
        startedAt,
      });
    }
  }

  function rememberFrozenPullRequestChecks(key: string, rollup: unknown[]): void {
    frozenPullRequestChecksCache.delete(key);
    frozenPullRequestChecksCache.set(key, rollup);
    while (frozenPullRequestChecksCache.size > FROZEN_PR_CHECKS_CACHE_MAX_ENTRIES) {
      const oldestKey = frozenPullRequestChecksCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      frozenPullRequestChecksCache.delete(oldestKey);
    }
  }

  function finalizeBatchPollTarget(input: {
    entry: GitHubBatchPollEntry;
    node: BatchPollPrNode | null;
    repository: BatchPollRepository;
    rollup: unknown[] | null;
    /** When this poll cycle became due; cache writes newer than this win. */
    startedAt: number;
  }): void {
    const { entry, node, repository } = input;
    let status: CurrentPullRequestStatus | null = null;
    if (node) {
      const facts: GitHubPullRequestStatusFacts = {
        mergeStateStatus: node.mergeStateStatus ?? null,
        autoMergeRequest: toGitHubAutoMergeRequest(node.autoMergeRequest),
        viewerCanEnableAutoMerge: node.viewerCanEnableAutoMerge ?? false,
        viewerCanDisableAutoMerge: node.viewerCanDisableAutoMerge ?? false,
        viewerCanMergeAsAdmin: node.viewerCanMergeAsAdmin ?? false,
        viewerCanUpdateBranch: node.viewerCanUpdateBranch ?? false,
        repository: toGitHubRepositoryMergePolicy(repository),
        isMergeQueueEnabled: node.isMergeQueueEnabled ?? false,
        isInMergeQueue: node.isInMergeQueue ?? false,
      };
      const built = toCurrentPullRequestStatus(
        toBatchCurrentPullRequestItem(node, input.rollup ?? undefined),
        entry.target.headRef,
      );
      status = built ? { ...built, forgeSpecific: { forge: "github", ...facts } } : null;
    }
    const cacheKey = buildCacheKey({
      cwd: entry.target.cwd,
      method: "getCurrentPullRequestStatus",
      args: {
        headRef: entry.target.headRef,
        headSha: entry.target.headSha,
        headRepositoryOwner: entry.target.headRepositoryOwner,
      },
    });
    // A direct or forced read can finish between this batch becoming due and
    // its checks query returning. Its cache write is newer than this cycle, so
    // converge on it instead of overwriting fresher data with the batch's.
    const existing = cache.get(cacheKey);
    if (existing && existing.expiresAt - ttlMs > input.startedAt) {
      updatePollTargetAfterSuccess({
        cwd: entry.target.cwd,
        headRef: entry.target.headRef,
        headSha: entry.target.headSha,
        headRepositoryOwner: entry.target.headRepositoryOwner,
        status: existing.value as CurrentPullRequestStatus | null,
        notify: true,
      });
      return;
    }
    // Mirror the cached() write of getCurrentPullRequestStatus so direct reads
    // between polls reuse the batch result instead of spawning gh again.
    cache.set(cacheKey, { value: status, cwd: entry.target.cwd, expiresAt: deps.now() + ttlMs });
    updatePollTargetAfterSuccess({
      cwd: entry.target.cwd,
      headRef: entry.target.headRef,
      headSha: entry.target.headSha,
      headRepositoryOwner: entry.target.headRepositoryOwner,
      status,
      notify: true,
    });
  }

  async function runGitHubPoll(target: GitHubPollTarget): Promise<void> {
    try {
      await api.getCurrentPullRequestStatus({
        cwd: target.cwd,
        headRef: target.headRef,
        headSha: target.headSha,
        headRepositoryOwner: target.headRepositoryOwner,
        reason: "self-heal-github",
      });
    } catch (error) {
      updatePollTargetAfterError(target, error);
    }
  }

  function updatePollTargetAfterError(target: GitHubPollTarget, error: unknown): void {
    if (target.retainCount <= 0) {
      return;
    }
    target.consecutiveErrors += 1;
    for (const callback of target.errorCallbacks) {
      callback(error);
    }
    scheduleGitHubPoll(target);
  }

  function closeGitHubPollTarget(target: GitHubPollTarget): void {
    target.nextDueAt = null;
    target.pollCycleStartedAt = null;
    target.retainCount = 0;
    target.callbacks.clear();
    target.errorCallbacks.clear();
  }

  api = {
    authProbeCanThrow: true,

    listPullRequests(input) {
      return cached({
        cwd: input.cwd,
        method: "listPullRequests",
        args: { query: input.query ?? "", limit: input.limit ?? 20 },
        readOptions: input,
        load: async () => {
          const items = await runGhJson(
            [
              "pr",
              "list",
              "--search",
              input.query ?? "",
              "--json",
              "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
              "--limit",
              String(input.limit ?? 20),
            ],
            { cwd: input.cwd },
            z.array(GitHubPullRequestSummarySchema),
            "[]",
          );
          return items.map(toPullRequestSummary);
        },
      });
    },

    listIssues(input) {
      return cached({
        cwd: input.cwd,
        method: "listIssues",
        args: { query: input.query ?? "", limit: input.limit ?? 20 },
        readOptions: input,
        load: async () => {
          const items = await runGhJson(
            [
              "issue",
              "list",
              "--search",
              input.query ?? "",
              "--json",
              "number,title,url,state,body,labels,updatedAt",
              "--limit",
              String(input.limit ?? 20),
            ],
            { cwd: input.cwd },
            z.array(GitHubIssueSummarySchema),
            "[]",
          );
          return items.map(toIssueSummary);
        },
      });
    },

    getPullRequest(input) {
      return cached({
        cwd: input.cwd,
        method: "getPullRequest",
        args: { number: input.number },
        readOptions: input,
        load: async () => {
          const item = await runGhJson(
            [
              "pr",
              "view",
              String(input.number),
              "--json",
              "number,title,url,state,body,labels,baseRefName,headRefName,updatedAt",
            ],
            { cwd: input.cwd },
            GitHubPullRequestSummarySchema,
            "{}",
          );
          return toPullRequestSummary(item);
        },
      });
    },

    async getPullRequestHeadRef(input) {
      const pullRequest = await this.getPullRequest(input);
      return pullRequest.headRefName;
    },

    defaultCheckoutRefs({ changeRequestNumber }) {
      return [
        { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
        { remoteName: "upstream", remoteRef: `refs/pull/${changeRequestNumber}/head` },
      ];
    },

    buildPrLocalBranchName({ headRef, checkoutTarget }) {
      const owner = checkoutTarget.isCrossRepository
        ? normalizeGitHubOwnerForBranch(checkoutTarget.headOwnerLogin)
        : null;
      return owner ? `${owner}/${headRef}` : headRef;
    },

    supportsCrossRepoCheckoutWithoutRefs: true,

    getPullRequestCheckoutTarget(input) {
      return cached({
        cwd: input.cwd,
        method: "getPullRequestCheckoutTarget",
        args: { number: input.number },
        readOptions: input,
        load: async () => {
          const repo = await getGitHubRepoView({ cwd: input.cwd, run });
          const owner = repo?.owner?.login;
          const name = repo?.name;
          if (!owner || !name) {
            throw new Error("Unable to resolve GitHub repository for pull request checkout");
          }

          const parsed = await runGhJson(
            [
              "api",
              "graphql",
              "-f",
              `query=${PULL_REQUEST_CHECKOUT_TARGET_QUERY}`,
              "-F",
              `owner=${owner}`,
              "-F",
              `name=${name}`,
              "-F",
              `number=${input.number}`,
            ],
            { cwd: input.cwd },
            PullRequestCheckoutTargetSchema,
            "{}",
          );
          return toPullRequestCheckoutTarget(parsed);
        },
      });
    },

    getCurrentPullRequestStatus(input) {
      return cached({
        cwd: input.cwd,
        method: "getCurrentPullRequestStatus",
        args: {
          headRef: input.headRef,
          headSha: input.headSha,
          headRepositoryOwner: input.headRepositoryOwner,
        },
        readOptions: input,
        load: async () => {
          const status = await resolveCurrentPullRequestView({
            cwd: input.cwd,
            headRef: input.headRef,
            headSha: input.headSha,
            headRepositoryOwner: input.headRepositoryOwner,
            run,
          });
          return addCurrentPullRequestGithubFacts({ cwd: input.cwd, status, run });
        },
      }).then((status) => {
        updatePollTargetAfterSuccess({
          cwd: input.cwd,
          headRef: input.headRef,
          headSha: input.headSha,
          headRepositoryOwner: input.headRepositoryOwner,
          status,
          notify: input.reason === "self-heal-github",
        });
        return status;
      });
    },

    getPullRequestTimeline(input) {
      return cached({
        cwd: input.cwd,
        method: "getPullRequestTimeline",
        args: { prNumber: input.prNumber },
        readOptions: input,
        load: async () => {
          try {
            const parsed = await runGhJson(
              [
                "api",
                "graphql",
                "-f",
                `query=${PULL_REQUEST_TIMELINE_QUERY}`,
                "-F",
                `owner=${input.repoOwner}`,
                "-F",
                `name=${input.repoName}`,
                "-F",
                `number=${input.prNumber}`,
              ],
              { cwd: input.cwd },
              PullRequestTimelineGraphqlSchema,
              "{}",
            );
            return toPullRequestTimeline(parsed, {
              prNumber: input.prNumber,
              repoOwner: input.repoOwner,
              repoName: input.repoName,
            });
          } catch (error) {
            return {
              prNumber: input.prNumber,
              repoOwner: input.repoOwner,
              repoName: input.repoName,
              items: [],
              truncated: false,
              error: mapPullRequestTimelineError(error),
            };
          }
        },
      });
    },

    getCheckDetails(input) {
      const { repoOwner, repoName, checkRunId } = input;
      if (!repoOwner || !repoName) {
        throw new Error("GitHub getCheckDetails requires repoOwner and repoName");
      }
      if (checkRunId === undefined) {
        throw new Error("GitHub getCheckDetails requires checkRunId");
      }
      return cached({
        cwd: input.cwd,
        method: "getCheckDetails",
        args: {
          repoOwner,
          repoName,
          checkRunId,
          workflowRunId: input.workflowRunId,
        },
        readOptions: input,
        load: async () => {
          const repoPath = `repos/${repoOwner}/${repoName}`;
          const checkRun = toGitHubCheckRunDetails(
            await runGhJson(
              ["api", `${repoPath}/check-runs/${checkRunId}`],
              { cwd: input.cwd },
              GitHubCheckRunDetailsSchema,
              "{}",
            ),
          );
          const annotations = toGitHubCheckAnnotations(
            await runGhJson(
              [
                "api",
                `${repoPath}/check-runs/${checkRunId}/annotations`,
                "-f",
                `per_page=${CHECK_ANNOTATION_PAGE_MAX}`,
              ],
              {
                cwd: input.cwd,
              },
              GitHubCheckAnnotationsSchema,
              "[]",
            ),
          );
          const workflowRunId = input.workflowRunId ?? checkRun.workflowRunId ?? null;
          const failedJobs: CheckFailedJob[] = [];
          let truncated = annotations.length >= CHECK_ANNOTATION_PAGE_MAX;

          if (typeof workflowRunId === "number") {
            const jobs = toGitHubActionsJobs(
              await runGhJson(
                [
                  "api",
                  `${repoPath}/actions/runs/${workflowRunId}/jobs`,
                  "-f",
                  `per_page=${ACTIONS_JOB_PAGE_MAX}`,
                ],
                {
                  cwd: input.cwd,
                },
                GitHubActionsJobsSchema,
                "{}",
              ),
            );
            const failed = jobs.filter(isFailedActionsJob);
            truncated ||= jobs.length >= ACTIONS_JOB_PAGE_MAX;
            truncated ||= failed.length > FAILED_CHECK_JOB_LIMIT;
            for (const job of failed.slice(0, FAILED_CHECK_JOB_LIMIT)) {
              const log = await getCachedCheckLogTail({
                cwd: input.cwd,
                repoPath,
                job,
                run,
                cache: checkLogTailCache,
              });
              truncated ||= log.logTruncated;
              failedJobs.push({
                jobId: job.jobId,
                name: job.name,
                status: job.status,
                conclusion: job.conclusion,
                url: job.url,
                logTail: log.logTail,
                logTruncated: log.logTruncated,
              });
            }
          }

          return {
            checkRunId: checkRun.checkRunId,
            workflowRunId,
            name: checkRun.name,
            status: checkRun.status,
            conclusion: checkRun.conclusion,
            url: checkRun.url,
            detailsUrl: checkRun.detailsUrl,
            output: checkRun.output,
            annotations,
            failedJobs,
            truncated,
          };
        },
      });
    },

    async searchRepositories(input) {
      const limit = input.limit ?? 20;
      const query = input.query.trim();
      if (query.length === 0) {
        const [stdout, cloneProtocol] = await Promise.all([
          run(
            [
              "repo",
              "list",
              "--json",
              "id,name,nameWithOwner,description,isPrivate,updatedAt,sshUrl,url",
              "--limit",
              String(limit),
            ],
            { cwd: input.cwd },
          ),
          resolveConfiguredCloneProtocol(input.cwd, run),
        ]);
        return parseRepositoryList(stdout, cloneProtocol);
      }

      const [stdout, cloneProtocol] = await Promise.all([
        run(
          [
            "search",
            "repos",
            query,
            "--json",
            "id,name,fullName,description,isPrivate,updatedAt,url",
            "--sort",
            "updated",
            "--order",
            "desc",
            "--limit",
            String(limit),
          ],
          { cwd: input.cwd },
        ),
        resolveConfiguredCloneProtocol(input.cwd, run),
      ]);
      return parseRepositorySearch(stdout, cloneProtocol);
    },

    async searchIssuesAndPrs(input) {
      if (input.force && !input.reason) {
        throw new Error("ForgeService forced read requires a reason");
      }

      const kinds = normalizeForgeSearchKinds(input.kinds);
      const shouldFetchIssues = kinds.includes("issue");
      const shouldFetchPullRequests = kinds.includes("change_request");
      const readOptions: ForgeReadOptions = input.force
        ? { force: true, reason: input.reason }
        : { force: false, reason: input.reason };
      const enterpriseHost = await resolveRepoHostCached(input.cwd).catch(() => null);
      const query = normalizeGitHubSearchQuery(input.query, enterpriseHost);
      const [issuesResult, prsResult] = await Promise.allSettled([
        shouldFetchIssues
          ? this.listIssues({
              cwd: input.cwd,
              query,
              limit: input.limit,
              ...readOptions,
            })
          : Promise.resolve(null),
        shouldFetchPullRequests
          ? this.listPullRequests({
              cwd: input.cwd,
              query,
              limit: input.limit,
              ...readOptions,
            })
          : Promise.resolve(null),
      ]);

      const items: SearchResult["items"] = [];
      const requestedResults = [
        shouldFetchIssues ? issuesResult : null,
        shouldFetchPullRequests ? prsResult : null,
      ].filter((result) => result !== null);
      if (
        requestedResults.length > 0 &&
        requestedResults.every(
          (result) =>
            result.status === "rejected" &&
            (result.reason instanceof GitHubCliMissingError ||
              result.reason instanceof GitHubAuthenticationError),
        )
      ) {
        const hasMissingCli = requestedResults.some(
          (result) =>
            result.status === "rejected" && result.reason instanceof GitHubCliMissingError,
        );
        return createUnavailableSearchResult(hasMissingCli ? "cli_missing" : "unauthenticated");
      }

      if (shouldFetchIssues && issuesResult.status === "fulfilled") {
        for (const item of issuesResult.value ?? []) {
          items.push({
            kind: "issue",
            number: item.number,
            title: item.title,
            url: item.url,
            state: item.state,
            body: item.body,
            labels: item.labels,
            baseRefName: null,
            headRefName: null,
            updatedAt: item.updatedAt,
          });
        }
      }

      if (shouldFetchPullRequests && prsResult.status === "fulfilled") {
        for (const item of prsResult.value ?? []) {
          items.push({
            kind: "change_request",
            number: item.number,
            title: item.title,
            url: item.url,
            state: item.state,
            body: item.body,
            labels: item.labels,
            baseRefName: item.baseRefName,
            headRefName: item.headRefName,
            updatedAt: item.updatedAt,
          });
        }
      }

      items.sort((left, right) => {
        const leftTime = parseOptionalTime(left.updatedAt ?? null);
        const rightTime = parseOptionalTime(right.updatedAt ?? null);
        return rightTime - leftTime;
      });

      return {
        items,
        featuresEnabled: true,
        authState: "authenticated",
        githubFeaturesEnabled: true,
      };
    },

    async createPullRequest(input) {
      // Resolve the owner/name slug offline from the origin remote first so a
      // transient `gh repo view` failure can't block PR creation on github.com.
      // `gh repo view` is the fallback: it auto-routes to the cwd remote's host
      // (covering GitHub Enterprise Server) and survives a renamed repo.
      let slug = await resolveGitHubSlugFromOrigin(input.cwd);
      if (!slug) {
        const repoView = await getGitHubRepoView({ cwd: input.cwd, run });
        slug =
          repoView?.owner?.login && repoView.name
            ? `${repoView.owner.login}/${repoView.name}`
            : null;
      }
      if (!slug) {
        throw new Error("Unable to resolve GitHub repository for pull request creation");
      }
      const args = ["api", "-X", "POST", `repos/${slug}/pulls`, "-f", `title=${input.title}`];
      args.push("-f", `head=${input.head}`);
      args.push("-f", `base=${input.base}`);
      if (input.body) {
        args.push("-f", `body=${input.body}`);
      }
      const parsed = await runGhJson(
        args,
        { cwd: input.cwd },
        z.object({
          url: z.string(),
          number: z.number(),
        }),
        "{}",
      );
      return parsed;
    },

    async mergePullRequest(input) {
      assertDirectPullRequestMergeReady(input);
      await run(["pr", "merge", String(input.prNumber), `--${input.mergeMethod}`], {
        cwd: input.cwd,
        envOverlay: { GH_PROMPT_DISABLED: "1" },
      });
      return { success: true };
    },

    async enablePullRequestAutoMerge(input) {
      assertPullRequestAutoMergeEnableReady(input);
      await run(["pr", "merge", String(input.prNumber), "--auto", `--${input.mergeMethod}`], {
        cwd: input.cwd,
        envOverlay: { GH_PROMPT_DISABLED: "1" },
      });
      return { success: true };
    },

    async disablePullRequestAutoMerge(input) {
      assertPullRequestAutoMergeDisableReady(input);
      await run(["pr", "merge", String(input.prNumber), "--disable-auto"], {
        cwd: input.cwd,
        envOverlay: { GH_PROMPT_DISABLED: "1" },
      });
      return { success: true };
    },

    isAuthenticated(input) {
      return cached({
        cwd: input.cwd,
        method: "isAuthenticated",
        args: {},
        readOptions: input,
        load: async () => {
          try {
            await run(["auth", "status"], { cwd: input.cwd });
            return true;
          } catch (error) {
            if (isGitHubAuthenticationError(error)) {
              throw error;
            }
            if (error instanceof GitHubCommandError && isAuthFailureText(error.stderr)) {
              throw new GitHubAuthenticationError({ stderr: error.stderr });
            }
            throw error;
          }
        },
      });
    },

    retainCurrentPullRequestStatusPoll(input) {
      const key = getPollTargetKey(input);
      let target = pollTargets.get(key);
      if (!target) {
        target = {
          cwd: input.cwd,
          headRef: input.headRef,
          headSha: input.headSha,
          headRepositoryOwner: input.headRepositoryOwner,
          retainCount: 0,
          nextDueAt: null,
          pollCycleStartedAt: null,
          latestStatus: null,
          consecutiveErrors: 0,
          callbacks: new Set(),
          errorCallbacks: new Set(),
        };
        pollTargets.set(key, target);
        // Warm the host and slug caches so the first poll flush can already
        // batch this target instead of taking the legacy per-target path.
        void resolveRepoHostCached(input.cwd).catch(() => {});
        void resolveRepoSlugCached(input.cwd);
      }

      const isNewlyRetained = target.retainCount === 0;
      target.retainCount += 1;
      if (input.onStatus) {
        target.callbacks.add(input.onStatus);
      }
      if (input.onError) {
        target.errorCallbacks.add(input.onError);
      }
      if (isNewlyRetained) {
        scheduleImmediateGitHubPoll(target);
      } else {
        scheduleGitHubPoll(target);
      }

      let unsubscribed = false;
      return {
        unsubscribe: () => {
          if (unsubscribed) {
            return;
          }
          unsubscribed = true;
          if (input.onStatus) {
            target.callbacks.delete(input.onStatus);
          }
          if (input.onError) {
            target.errorCallbacks.delete(input.onError);
          }
          target.retainCount -= 1;
          if (target.retainCount > 0) {
            return;
          }
          closeGitHubPollTarget(target);
          pollTargets.delete(key);
          armGitHubPollTimer();
        },
      };
    },

    invalidate(input) {
      // Local checkout mutations that can alter the current PR identity or PR status
      // must call this with the affected cwd before broadcasting fresh git state.
      for (const [key, entry] of cache.entries()) {
        if (entry.cwd === input.cwd) {
          cache.delete(key);
        }
      }
      for (const [key, entry] of inFlight.entries()) {
        if (entry.cwd === input.cwd) {
          inFlight.delete(key);
        }
      }
      // Drop the cached host and slug so a changed remote re-resolves GH_HOST
      // and the batch-poll repository identity instead of reusing stale ones.
      repoHostByCwd.delete(input.cwd);
      repoSlugByCwd.delete(input.cwd);
    },

    dispose() {
      if (githubPollTimer) {
        clearTimeout(githubPollTimer);
        githubPollTimer = null;
      }
      for (const target of pollTargets.values()) {
        closeGitHubPollTarget(target);
      }
      pollTargets.clear();
      pollRepositoryRedirects.clear();
      pollPausedUntilByHost.clear();
      rateLimitResetLoads.clear();
    },
  };

  return api;
}

function normalizeGitHubOwnerForBranch(owner: string | null): string | null {
  const normalized = owner?.trim().toLowerCase() ?? "";
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
}

function getGithubStatusFacts(
  status: PullRequestCommandStatus | null | undefined,
): GitHubPullRequestStatusFacts | null {
  const forgeSpecific = status?.forgeSpecific;
  return isGitHubPullRequestStatusFacts(forgeSpecific) ? forgeSpecific : null;
}

function assertDirectPullRequestMergeReady(input: MergePullRequestOptions): void {
  const github = getGithubStatusFacts(input.status);
  if (!github) {
    throw new Error("GitHub merge facts are unavailable for this pull request");
  }

  if (!DIRECT_PULL_REQUEST_MERGE_STATE_ALLOWLIST.has(github.mergeStateStatus ?? "")) {
    throw new Error("GitHub does not report this pull request as ready for direct merge");
  }
  if (github.isMergeQueueEnabled || github.isInMergeQueue) {
    throw new Error("Direct merge is not available because this repository uses a merge queue");
  }
  if (github.autoMergeRequest !== null) {
    throw new Error("Direct merge is not available because auto-merge is already enabled");
  }
  if (!isPullRequestMergeMethodAllowed(github.repository, input.mergeMethod)) {
    throw new Error(`Direct merge is not available because ${input.mergeMethod} is disabled`);
  }
}

export function assertPullRequestAutoMergeEnableReady(
  input: Pick<EnablePullRequestAutoMergeOptions, "mergeMethod" | "status">,
): void {
  const github = getGithubStatusFacts(input.status);
  if (!github) {
    throw new Error("GitHub auto-merge facts are unavailable for this pull request");
  }

  if (github.mergeStateStatus !== "BLOCKED") {
    throw new Error("GitHub does not report this pull request as blocked for auto-merge");
  }
  if (!github.viewerCanEnableAutoMerge) {
    throw new Error("GitHub does not allow this viewer to enable auto-merge");
  }
  if (!github.repository.autoMergeAllowed) {
    throw new Error("Auto-merge is disabled for this repository");
  }
  if (!isPullRequestMergeMethodAllowed(github.repository, input.mergeMethod)) {
    throw new Error(`Auto-merge is not available because ${input.mergeMethod} is disabled`);
  }
  if (github.autoMergeRequest !== null) {
    throw new Error("Auto-merge is already enabled for this pull request");
  }
  if (github.isMergeQueueEnabled || github.isInMergeQueue) {
    throw new Error("Auto-merge is not available because this repository uses a merge queue");
  }
  if (input.status?.mergeable === "CONFLICTING") {
    throw new Error("Auto-merge is not available because this pull request has conflicts");
  }
}

export function assertPullRequestAutoMergeDisableReady(
  input: Pick<DisablePullRequestAutoMergeOptions, "status">,
): void {
  const github = getGithubStatusFacts(input.status);
  if (!github) {
    throw new Error("GitHub auto-merge facts are unavailable for this pull request");
  }

  if (github.autoMergeRequest === null) {
    throw new Error("Auto-merge is not enabled for this pull request");
  }
  if (!github.viewerCanDisableAutoMerge) {
    throw new Error("GitHub does not allow this viewer to disable auto-merge");
  }
  if (github.isMergeQueueEnabled || github.isInMergeQueue) {
    throw new Error("Auto-merge is not available because this repository uses a merge queue");
  }
}

export function isPullRequestMergeMethodAllowed(
  repository: GitHubPullRequestStatusFacts["repository"],
  method: PullRequestMergeMethod,
): boolean {
  if (method === "squash") {
    return repository.squashMergeAllowed;
  }
  if (method === "merge") {
    return repository.mergeCommitAllowed;
  }
  return repository.rebaseMergeAllowed;
}

export function computeGithubNextInterval(
  status: CurrentPullRequestStatus | null,
  consecutiveErrors: number,
): number {
  const baseInterval = isGitHubStatusPending(status)
    ? GITHUB_POLL_FAST_INTERVAL_MS
    : GITHUB_POLL_SLOW_INTERVAL_MS;
  if (consecutiveErrors <= 1) {
    return baseInterval;
  }

  return Math.min(baseInterval * 2 ** (consecutiveErrors - 1), GITHUB_POLL_ERROR_BACKOFF_CAP_MS);
}

function isGitHubStatusPending(status: CurrentPullRequestStatus | null): boolean {
  if (!status) {
    return false;
  }
  if (status.checksStatus === "pending") {
    return true;
  }
  return status.checks.some((check) => check.status === "pending");
}

async function resolveGhPath(): Promise<string | null> {
  return findExecutable("gh");
}

/**
 * Detect whether a self-hosted host is GitHub Enterprise Server by asking the
 * local gh CLI whether it is already authenticated to that exact hostname.
 * Cloud github.com short-circuits via the registry's host match before this runs.
 */
export async function probeGitHubHost(host: string): Promise<boolean> {
  return probeGitHubAuthStatus(host);
}

async function probeGitHubAuthStatus(host: string): Promise<boolean> {
  return probeHostViaCliAuthStatus({
    cli: "gh",
    host,
    envOverlay: { ...GITHUB_ENV, GH_PROMPT_DISABLED: "1" },
  });
}

async function probeGitHubAuthStatusForRouting(host: string): Promise<boolean> {
  const ghPath = await findExecutable("gh");
  if (!ghPath) {
    throw new GitHubCliMissingError();
  }

  const args = ["auth", "status", "--hostname", host];
  try {
    await execCommand(ghPath, args, {
      envOverlay: { ...GITHUB_ENV, GH_PROMPT_DISABLED: "1" },
      timeout: CLI_AUTH_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    const normalized = githubCliRunner.normalizeError(error, {
      args,
      cwd: process.cwd(),
      timeoutMs: CLI_AUTH_PROBE_TIMEOUT_MS,
    });
    if (isGitHubAuthenticationError(normalized)) {
      return false;
    }
    throw new GitHubEnterpriseHostProbeError({ host, cause: normalized });
  }
}

const githubCliRunner = createForgeCliRunner({
  binary: "gh",
  envOverlay: GITHUB_ENV,
  timeoutMs: GITHUB_COMMAND_TIMEOUT_MS,
  isAuthFailureText,
  errorClasses: {
    isAlreadyClassified: (candidate) => candidate instanceof GitHubAuthenticationError,
    isCommandError: (candidate): candidate is GitHubCommandError =>
      candidate instanceof GitHubCommandError,
    createAuthError: (stderr) => new GitHubAuthenticationError({ stderr }),
    createMissingError: () => new GitHubCliMissingError(),
    createCommandError: (params) => new GitHubCommandError(params),
  },
});

async function runGhCommand(
  args: string[],
  options: GitHubCommandRunnerOptions,
): Promise<GitHubCommandResult> {
  return githubCliRunner.run(args, options);
}

// Anchored to github.com so a pasted URL from an unrelated tracker (a GitLab
// or Gitea link that happens to share the /owner/repo/(pull|issues)/N shape)
// passes through as literal search text instead of being misread as a number.
// The workspace's resolved GitHub Enterprise host (if any) is accepted too.
const GITHUB_COM_ISSUE_OR_PR_URL_PATTERN =
  /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/i;

function buildEnterpriseIssueOrPrUrlPattern(host: string): RegExp {
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^https?://${escapedHost}/[^/\\s]+/[^/\\s]+/(?:pull|issues)/(\\d+)(?:[/?#].*)?$`,
    "i",
  );
}

function normalizeGitHubSearchQuery(query: string, enterpriseHost: string | null): string {
  const trimmed = query.trim();
  const cloudMatch = trimmed.match(GITHUB_COM_ISSUE_OR_PR_URL_PATTERN);
  if (cloudMatch) {
    return cloudMatch[1];
  }
  if (enterpriseHost) {
    const enterpriseMatch = trimmed.match(buildEnterpriseIssueOrPrUrlPattern(enterpriseHost));
    if (enterpriseMatch) {
      return enterpriseMatch[1];
    }
  }
  return query;
}

function buildCacheKey(params: { cwd: string; method: string; args: unknown }): string {
  return `${params.cwd}:${params.method}:${stableStringify(params.args)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const sorted: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    sorted[key] = sortJsonValue(entryValue);
  }
  return sorted;
}

function parseGitHubJsonOutput<T>(
  stdout: string,
  schema: z.ZodType<T>,
  context: { args: string[]; cwd: string; emptyFallback: string },
): T {
  return parseCliJsonOutput({
    commandName: "gh",
    args: context.args,
    cwd: context.cwd,
    stdout: stdout || context.emptyFallback,
    schema,
    createCommandError: (params) => new GitHubCommandError(params),
  });
}

function isGitHubAuthenticationError(error: unknown): error is GitHubAuthenticationError {
  return error instanceof GitHubAuthenticationError;
}

function isAuthFailureText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("gh auth login") ||
    normalized.includes("not logged into any github hosts") ||
    normalized.includes("authentication failed") ||
    normalized.includes("authentication required") ||
    normalized.includes("bad credentials") ||
    normalized.includes("http 401")
  );
}

function isNoPullRequestFoundError(error: unknown): boolean {
  if (!(error instanceof GitHubCommandError)) {
    return false;
  }
  const text = error.stderr.toLowerCase();
  return text.includes("no pull requests found");
}

function isStatusCheckRollupPermissionError(error: unknown): boolean {
  if (!(error instanceof GitHubCommandError)) {
    return false;
  }
  return error.stderr.toLowerCase().includes("statuscheckrollup");
}

function isGitHubRateLimitError(error: unknown): boolean {
  return (
    error instanceof GitHubCommandError &&
    /(?:rate limit|rate_limit).*(?:exceed|exhaust)|(?:exceed|exhaust).*rate limit/i.test(
      error.stderr,
    )
  );
}

async function resolveCurrentPullRequestView(options: {
  cwd: string;
  headRef: string;
  headSha?: string;
  headRepositoryOwner?: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
}): Promise<CurrentPullRequestStatus | null> {
  const viewCandidate = await tryCurrentPullRequestView(options);
  const viewMatch = viewCandidate
    ? pickPullRequestCandidate({
        candidates: [viewCandidate],
        headRef: options.headRef,
        headSha: options.headSha,
        headRepositoryOwner: options.headRepositoryOwner,
      })
    : null;
  if (viewMatch) {
    return viewMatch.status;
  }

  let listHeadRef = options.headRef;
  let listRepo: string | undefined;
  let headRepositoryOwner = options.headRepositoryOwner;

  if (!headRepositoryOwner) {
    const repo = await getGitHubRepoView(options);
    const forkOwner = repo?.owner?.login;
    const parentOwner = repo?.parent?.owner?.login;
    const parentName = repo?.parent?.name;
    if (!forkOwner) {
      return null;
    }
    if (parentOwner && parentName) {
      listHeadRef = `${forkOwner}:${options.headRef}`;
      listRepo = `${parentOwner}/${parentName}`;
    }
    headRepositoryOwner = forkOwner;
  }

  const candidates = await listCurrentPullRequestCandidates({
    cwd: options.cwd,
    headRef: listHeadRef,
    run: options.run,
    repo: listRepo,
  });
  const match = pickPullRequestCandidate({
    candidates,
    headRef: options.headRef,
    headSha: options.headSha,
    headRepositoryOwner,
  });
  return match?.status ?? null;
}

async function addCurrentPullRequestGithubFacts(options: {
  cwd: string;
  status: CurrentPullRequestStatus | null;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
}): Promise<CurrentPullRequestStatus | null> {
  const { status } = options;
  if (!status?.repoOwner || !status.repoName || typeof status.number !== "number") {
    return status;
  }

  const facts = await loadPullRequestGithubFacts({
    cwd: options.cwd,
    owner: status.repoOwner,
    name: status.repoName,
    number: status.number,
    run: options.run,
  });
  if (!facts) {
    return status;
  }
  return {
    ...status,
    forgeSpecific: { forge: "github", ...facts },
  };
}

async function loadPullRequestGithubFacts(options: {
  cwd: string;
  owner: string;
  name: string;
  number: number;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
}): Promise<GitHubPullRequestStatusFacts | null> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${PULL_REQUEST_STATUS_FACTS_QUERY}`,
    "-F",
    `owner=${options.owner}`,
    "-F",
    `name=${options.name}`,
    "-F",
    `number=${options.number}`,
  ];
  try {
    const stdout = await options.run(args, { cwd: options.cwd });
    return parsePullRequestGithubFacts(stdout, { args, cwd: options.cwd });
  } catch (error) {
    if (error instanceof GitHubCommandError) {
      return null;
    }
    throw error;
  }
}

async function tryCurrentPullRequestView(options: {
  cwd: string;
  headRef: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
}): Promise<ResolvedPullRequestCandidate | null> {
  try {
    const stdout = await runCurrentPullRequestStatusCommand({
      cwd: options.cwd,
      run: options.run,
      args: ["pr", "view"],
    });
    return parseCurrentPullRequestCandidate(stdout, options.headRef, {
      args: ["pr", "view", "--json", CURRENT_PR_STATUS_FIELDS],
      cwd: options.cwd,
    });
  } catch (error) {
    if (isNoPullRequestFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function listCurrentPullRequestCandidates(options: {
  cwd: string;
  headRef: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
  repo?: string;
}): Promise<ResolvedPullRequestCandidate[]> {
  const args = ["pr", "list"];
  if (options.repo) {
    args.push("--repo", options.repo);
  }
  args.push("--state", "all", "--head", options.headRef, "--limit", "10");
  try {
    const stdout = await runCurrentPullRequestStatusCommand({
      cwd: options.cwd,
      run: options.run,
      args,
    });
    return parseCurrentPullRequestCandidateList(stdout, options.headRef, {
      args: [...args, "--json", CURRENT_PR_STATUS_FIELDS],
      cwd: options.cwd,
    });
  } catch (error) {
    if (isNoPullRequestFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function runCurrentPullRequestStatusCommand(options: {
  cwd: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
  args: string[];
}): Promise<string> {
  try {
    return await options.run([...options.args, "--json", CURRENT_PR_STATUS_FIELDS], {
      cwd: options.cwd,
    });
  } catch (error) {
    if (!isStatusCheckRollupPermissionError(error)) {
      throw error;
    }
    return options.run([...options.args, "--json", CURRENT_PR_STATUS_BASE_FIELDS], {
      cwd: options.cwd,
    });
  }
}

async function resolveGitHubSlugFromOrigin(cwd: string): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await runGitCommand(["config", "--get", "remote.origin.url"], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: GIT_ORIGIN_URL_READ_TIMEOUT_MS,
    }));
  } catch {
    return null;
  }
  return parseGitHubRemoteUrl(stdout.trim())?.repo ?? null;
}

async function getGitHubRepoView(options: {
  cwd: string;
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
}): Promise<z.infer<typeof GitHubRepoViewSchema> | null> {
  const args = ["repo", "view", "--json", "owner,name,parent"];
  try {
    const stdout = await options.run(args, {
      cwd: options.cwd,
    });
    return parseGitHubJsonOutput(stdout, GitHubRepoViewSchema, {
      args,
      cwd: options.cwd,
      emptyFallback: "{}",
    });
  } catch (error) {
    // A missing CLI or an auth failure must surface as its typed class so the
    // caller reports the real problem; only a genuine "not a resolvable repo"
    // (gh command failure / malformed output) degrades to null.
    if (
      error instanceof GitHubEnterpriseHostProbeError ||
      error instanceof GitHubCliMissingError ||
      isGitHubAuthenticationError(error)
    ) {
      throw error;
    }
    return null;
  }
}

function parseCurrentPullRequestCandidate(
  stdout: string,
  fallbackHeadRefName: string,
  context: { args: string[]; cwd: string },
): ResolvedPullRequestCandidate | null {
  const item = parseGitHubJsonOutput(stdout, CurrentPullRequestStatusSchema, {
    ...context,
    emptyFallback: "{}",
  });
  return toCurrentPullRequestCandidate(item, fallbackHeadRefName);
}

function parseCurrentPullRequestCandidateList(
  stdout: string,
  fallbackHeadRefName: string,
  context: { args: string[]; cwd: string },
): ResolvedPullRequestCandidate[] {
  const items = parseGitHubJsonOutput(stdout, z.array(CurrentPullRequestStatusSchema), {
    ...context,
    emptyFallback: "[]",
  });
  return items
    .map((item) => toCurrentPullRequestCandidate(item, fallbackHeadRefName))
    .filter((candidate): candidate is ResolvedPullRequestCandidate => candidate !== null);
}

function parsePullRequestGithubFacts(
  stdout: string,
  context: { args: string[]; cwd: string },
): GitHubPullRequestStatusFacts | null {
  const parsed = parseGitHubJsonOutput(stdout, GitHubPullRequestFactsGraphqlSchema, {
    ...context,
    emptyFallback: "{}",
  });
  const repository = parsed.data.repository;
  const pullRequest = repository?.pullRequest;
  if (!repository || !pullRequest) {
    return null;
  }

  return {
    mergeStateStatus: pullRequest.mergeStateStatus ?? null,
    autoMergeRequest: toGitHubAutoMergeRequest(pullRequest.autoMergeRequest),
    viewerCanEnableAutoMerge: pullRequest.viewerCanEnableAutoMerge ?? false,
    viewerCanDisableAutoMerge: pullRequest.viewerCanDisableAutoMerge ?? false,
    viewerCanMergeAsAdmin: pullRequest.viewerCanMergeAsAdmin ?? false,
    viewerCanUpdateBranch: pullRequest.viewerCanUpdateBranch ?? false,
    repository: toGitHubRepositoryMergePolicy(repository),
    isMergeQueueEnabled: pullRequest.isMergeQueueEnabled ?? false,
    isInMergeQueue: pullRequest.isInMergeQueue ?? false,
  };
}

function toGitHubAutoMergeRequest(
  request: GitHubPullRequestFactsPullRequest["autoMergeRequest"],
): GitHubPullRequestStatusFacts["autoMergeRequest"] {
  if (!request) {
    return null;
  }
  return {
    enabledAt: request.enabledAt ?? null,
    mergeMethod: request.mergeMethod ?? null,
    enabledBy: request.enabledBy?.login ?? null,
  };
}

function toGitHubRepositoryMergePolicy(
  repository: GitHubPullRequestFactsRepository,
): GitHubPullRequestStatusFacts["repository"] {
  return {
    autoMergeAllowed: repository.autoMergeAllowed ?? false,
    mergeCommitAllowed: repository.mergeCommitAllowed ?? false,
    squashMergeAllowed: repository.squashMergeAllowed ?? false,
    rebaseMergeAllowed: repository.rebaseMergeAllowed ?? false,
    viewerDefaultMergeMethod: repository.viewerDefaultMergeMethod ?? null,
  };
}

// Reshape a batched GraphQL PR node into the gh CLI JSON shape so candidate
// picking and status construction stay shared with the per-target path.
function toBatchCurrentPullRequestItem(
  node: BatchPollPrNode,
  statusCheckRollup: unknown[] | undefined,
): CurrentPullRequestStatusItem {
  return {
    number: node.number,
    url: node.url,
    title: node.title,
    state: node.state,
    isDraft: node.isDraft ?? false,
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    ...(node.headRefOid ? { headRefOid: node.headRefOid } : {}),
    mergedAt: node.mergedAt ?? null,
    ...(statusCheckRollup ? { statusCheckRollup } : {}),
    reviewDecision: node.reviewDecision,
    mergeable: node.mergeable,
    headRepositoryOwner: node.headRepositoryOwner,
  };
}

function toCurrentPullRequestCandidate(
  item: CurrentPullRequestStatusItem,
  fallbackHeadRefName: string,
): ResolvedPullRequestCandidate | null {
  const status = toCurrentPullRequestStatus(item, fallbackHeadRefName);
  if (!status) {
    return null;
  }
  const headRepositoryOwner = item.headRepositoryOwner?.login;
  const headSha = item.headRefOid;
  return {
    status,
    ...(headSha ? { headSha } : {}),
    ...(headRepositoryOwner ? { headRepositoryOwner } : {}),
  };
}

function isCandidateForHeadRef(candidate: ResolvedPullRequestCandidate, headRef: string): boolean {
  return candidate.status.headRefName === headRef && hasResolvedRepoIdentity(candidate.status);
}

function hasResolvedRepoIdentity(status: CurrentPullRequestStatus): boolean {
  return Boolean(status.repoOwner && status.repoName);
}

function pickPullRequestCandidate(options: {
  candidates: ResolvedPullRequestCandidate[];
  headRef: string;
  headSha?: string;
  headRepositoryOwner?: string;
}): ResolvedPullRequestCandidate | null {
  const matching = options.candidates.filter((candidate) => {
    if (!isCandidateForHeadRef(candidate, options.headRef)) {
      return false;
    }
    if (
      candidate.status.state !== "open" &&
      (!options.headSha || candidate.headSha !== options.headSha)
    ) {
      return false;
    }
    if (!options.headRepositoryOwner) {
      return true;
    }
    return candidate.headRepositoryOwner === options.headRepositoryOwner;
  });
  matching.sort((left, right) =>
    comparePullRequestCandidatePreference(left, right, options.headSha),
  );
  return matching[0] ?? null;
}

function comparePullRequestCandidatePreference(
  left: ResolvedPullRequestCandidate,
  right: ResolvedPullRequestCandidate,
  headSha?: string,
): number {
  const stateRank = getPullRequestStateRank(left.status) - getPullRequestStateRank(right.status);
  if (stateRank !== 0) {
    return stateRank;
  }
  const leftExact = headSha !== undefined && left.headSha === headSha;
  const rightExact = headSha !== undefined && right.headSha === headSha;
  if (leftExact !== rightExact) {
    return leftExact ? -1 : 1;
  }
  return 0;
}

function getPullRequestStateRank(status: CurrentPullRequestStatus): number {
  if (status.state === "open" || status.isDraft) {
    return 0;
  }
  if (status.state === "merged") {
    return 1;
  }
  return 2;
}

type GitHubCloneProtocol = "https" | "ssh";

async function resolveConfiguredCloneProtocol(
  cwd: string,
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>,
): Promise<GitHubCloneProtocol> {
  try {
    const protocol = (
      await run(["config", "get", "git_protocol", "--host", "github.com"], {
        cwd,
      })
    )
      .trim()
      .toLowerCase();
    return protocol === "ssh" ? "ssh" : "https";
  } catch (error) {
    if (error instanceof GitHubCommandError) {
      return "https";
    }
    throw error;
  }
}

function parseRepositoryList(
  stdout: string,
  cloneProtocol: GitHubCloneProtocol,
): GitHubRepositorySummary[] {
  const parsed = z.array(GitHubRepositoryListItemSchema).parse(JSON.parse(stdout || "[]"));
  return parsed.map((repository) =>
    normalizeRepositorySummary({
      ...repository,
      nameWithOwner: repository.nameWithOwner,
      cloneUrl: cloneProtocol === "ssh" ? repository.sshUrl : repository.url,
    }),
  );
}

function parseRepositorySearch(
  stdout: string,
  cloneProtocol: GitHubCloneProtocol,
): GitHubRepositorySummary[] {
  const parsed = z.array(GitHubRepositorySearchItemSchema).parse(JSON.parse(stdout || "[]"));
  return parsed.map((repository) =>
    normalizeRepositorySummary({
      ...repository,
      nameWithOwner: repository.fullName,
      cloneUrl:
        cloneProtocol === "ssh" ? `git@github.com:${repository.fullName}.git` : repository.url,
    }),
  );
}

function normalizeRepositorySummary(repository: {
  id: string | number;
  name: string;
  nameWithOwner: string;
  description?: string | null;
  isPrivate: boolean;
  updatedAt: string;
  cloneUrl: string;
}): GitHubRepositorySummary {
  const nameWithOwner = repository.nameWithOwner.trim();
  if (!nameWithOwner.includes("/")) {
    throw new Error(`GitHub repository is missing owner identity: ${nameWithOwner}`);
  }
  return {
    id: String(repository.id).trim(),
    name: repository.name.trim(),
    nameWithOwner,
    description: repository.description ?? null,
    // We query isPrivate, not visibility: `gh repo list --json visibility` is unsupported before
    // gh 2.28 (Debian Bookworm ships 2.23), while isPrivate works on every version. The wire schema
    // requires the visibility enum, so old clients still get a value they can parse.
    visibility: repository.isPrivate ? "private" : "public",
    updatedAt: repository.updatedAt,
    cloneUrl: repository.cloneUrl.trim(),
  };
}

function toPullRequestCheckoutTarget(
  parsed: z.infer<typeof PullRequestCheckoutTargetSchema>,
): PullRequestCheckoutTarget {
  const pullRequest = parsed.data.repository.pullRequest;
  if (!pullRequest) {
    throw new Error("Pull request not found");
  }
  return {
    number: pullRequest.number,
    baseRefName: pullRequest.baseRefName,
    headRefName: pullRequest.headRefName,
    checkoutRefs: [
      { remoteName: "origin", remoteRef: `refs/pull/${pullRequest.number}/head` },
      { remoteName: "upstream", remoteRef: `refs/pull/${pullRequest.number}/head` },
    ],
    headOwnerLogin: pullRequest.headRepositoryOwner?.login || null,
    headRepositorySshUrl: pullRequest.headRepository?.sshUrl || null,
    headRepositoryUrl: pullRequest.headRepository?.url || null,
    isCrossRepository: pullRequest.isCrossRepository,
  };
}

function toPullRequestSummary(
  item: z.infer<typeof GitHubPullRequestSummarySchema>,
): PullRequestSummary {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    body: item.body,
    baseRefName: item.baseRefName,
    headRefName: item.headRefName,
    labels: item.labels.map((label) => label.name ?? "").filter((name) => name.length > 0),
    updatedAt: item.updatedAt,
  };
}

function toIssueSummary(item: z.infer<typeof GitHubIssueSummarySchema>): IssueSummary {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    body: item.body,
    labels: item.labels.map((label) => label.name ?? "").filter((name) => name.length > 0),
    updatedAt: item.updatedAt,
  };
}

function toPullRequestTimeline(
  parsed: z.infer<typeof PullRequestTimelineGraphqlSchema>,
  identity: { prNumber: number; repoOwner: string; repoName: string },
): PullRequestTimeline {
  const pullRequest = parsed.data?.repository?.pullRequest;
  const reviewThreadItems = pullRequest
    ? pullRequest.reviewThreads.nodes.flatMap(toPullRequestTimelineReviewThreadItems)
    : [];
  const reviewThreadItemIds = new Set(
    reviewThreadItems.map((item) => item.id).filter((id) => id.length > 0),
  );
  const items = pullRequest
    ? [
        ...pullRequest.reviews.nodes.flatMap(toPullRequestTimelineReviewItem),
        ...pullRequest.comments.nodes
          .filter((comment) => !reviewThreadItemIds.has(comment.id))
          .map(toPullRequestTimelineCommentItem),
        ...reviewThreadItems,
      ].sort(compareTimelineItems)
    : [];
  return {
    prNumber: pullRequest?.number ?? identity.prNumber,
    repoOwner: identity.repoOwner,
    repoName: identity.repoName,
    items,
    // S3 deliberately caps timeline fetches at the first 100 reviews, comments, and review threads.
    truncated: Boolean(
      pullRequest?.reviews.pageInfo.hasNextPage ||
      pullRequest?.comments.pageInfo.hasNextPage ||
      pullRequest?.reviewThreads.pageInfo.hasNextPage ||
      pullRequest?.reviewThreads.nodes.some((thread) => thread.comments.pageInfo.hasNextPage),
    ),
    error: pullRequest ? null : { kind: "not_found", message: "Pull request not found" },
  };
}

function toPullRequestTimelineReviewItem(
  review: z.infer<typeof PullRequestTimelineReviewNodeSchema>,
): PullRequestTimelineItem[] {
  const reviewState = mapTimelineReviewState(review.state, review.body ?? "");
  if (!reviewState) {
    return [];
  }
  return [
    {
      kind: "review",
      id: review.id,
      author: review.author?.login ?? "unknown",
      authorUrl: review.author?.url ?? null,
      avatarUrl: review.author?.avatarUrl ?? null,
      body: normalizeGitHubTimelineBody(review.body ?? "", review.bodyHTML ?? ""),
      createdAt: parseOptionalTime(review.submittedAt ?? null),
      url: review.url,
      reviewState,
    },
  ];
}

function toPullRequestTimelineCommentItem(
  comment: z.infer<typeof PullRequestTimelineCommentNodeSchema>,
): PullRequestTimelineItem {
  return {
    kind: "comment",
    id: comment.id,
    author: comment.author?.login ?? "unknown",
    authorUrl: comment.author?.url ?? null,
    avatarUrl: comment.author?.avatarUrl ?? null,
    body: normalizeGitHubTimelineBody(comment.body ?? "", comment.bodyHTML ?? ""),
    createdAt: parseOptionalTime(comment.createdAt ?? null),
    url: comment.url,
  };
}

interface ImageSourceReference {
  src: string;
  start: number;
  end: number;
}

const RAW_MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*([^\s)]+)(?:\s+["'][^)]*["'])?\s*\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
const GITHUB_RENDERED_IMAGE_HOSTS = new Set([
  "camo.githubusercontent.com",
  "private-user-images.githubusercontent.com",
]);

function normalizeGitHubTimelineBody(body: string, bodyHTML: string): string {
  const rawImages = extractRawImageSourceReferences(body);
  if (rawImages.length === 0) {
    return body;
  }

  const renderedSources = extractRenderedImageSources(bodyHTML);
  if (renderedSources.length !== rawImages.length) {
    return body;
  }

  let cursor = 0;
  let normalized = "";
  for (let index = 0; index < rawImages.length; index += 1) {
    const rawImage = rawImages[index];
    const renderedSrc = renderedSources[index];
    if (
      !rawImage ||
      !renderedSrc ||
      !isRawGitHubAttachmentSource(rawImage.src) ||
      !isGitHubRenderedImageSource(renderedSrc)
    ) {
      return body;
    }
    normalized += body.slice(cursor, rawImage.start);
    normalized += renderedSrc;
    cursor = rawImage.end;
  }
  normalized += body.slice(cursor);
  return normalized;
}

function extractRawImageSourceReferences(source: string): ImageSourceReference[] {
  const references = [
    ...extractHtmlImageSourceReferences(source),
    ...extractMarkdownImageSourceReferences(source),
  ];
  return references.sort((left, right) => left.start - right.start);
}

function extractRenderedImageSources(source: string): string[] {
  return extractHtmlImageSourceReferences(source).map((reference) => reference.src);
}

function extractHtmlImageSourceReferences(source: string): ImageSourceReference[] {
  const references: ImageSourceReference[] = [];
  HTML_IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_IMAGE_RE.exec(source)) !== null) {
    const src = decodeHtmlAttribute(match[2] ?? "");
    if (!src) {
      continue;
    }
    const rawAttributeSrc = match[2] ?? "";
    const start = match.index + match[0].indexOf(rawAttributeSrc);
    references.push({ src, start, end: start + rawAttributeSrc.length });
  }
  return references;
}

function extractMarkdownImageSourceReferences(source: string): ImageSourceReference[] {
  const references: ImageSourceReference[] = [];
  RAW_MARKDOWN_IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RAW_MARKDOWN_IMAGE_RE.exec(source)) !== null) {
    const src = match[1] ?? "";
    if (!src) {
      continue;
    }
    const start = match.index + match[0].indexOf(src);
    references.push({ src, start, end: start + src.length });
  }
  return references;
}

function isRawGitHubAttachmentSource(src: string): boolean {
  try {
    const url = new URL(src);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith("/user-attachments/assets/")
    );
  } catch {
    return false;
  }
}

function isGitHubRenderedImageSource(src: string): boolean {
  try {
    const url = new URL(src);
    return url.protocol === "https:" && GITHUB_RENDERED_IMAGE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function toPullRequestTimelineReviewThreadItems(
  thread: z.infer<typeof PullRequestReviewThreadNodeSchema>,
): PullRequestTimelineItem[] {
  return thread.comments.nodes.map((comment) => ({
    ...toPullRequestTimelineCommentItem(comment),
    ...(comment.pullRequestReview?.id ? { reviewId: comment.pullRequestReview.id } : {}),
    location: {
      path: thread.path,
      ...(thread.line !== null && thread.line !== undefined ? { line: thread.line } : {}),
      ...(thread.startLine !== null && thread.startLine !== undefined
        ? { startLine: thread.startLine }
        : {}),
      ...(thread.id ? { threadId: thread.id } : {}),
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
    },
  }));
}

function toGitHubCheckRunDetails(
  parsed: z.infer<typeof GitHubCheckRunDetailsSchema>,
): CheckDetails {
  return {
    checkRunId: parsed.id,
    workflowRunId: parsed.check_suite?.workflow_run?.id ?? null,
    name: parsed.name,
    status: parsed.status,
    conclusion: parsed.conclusion,
    url: parsed.html_url,
    detailsUrl: parsed.details_url,
    output: parsed.output,
    annotations: [],
    failedJobs: [],
    truncated: false,
  };
}

function toGitHubCheckAnnotations(
  annotations: z.infer<typeof GitHubCheckAnnotationsSchema>,
): CheckAnnotation[] {
  return annotations.map((annotation) => {
    const result: CheckAnnotation = {};
    if (annotation.path) result.path = annotation.path;
    if (annotation.start_line !== undefined) result.startLine = annotation.start_line;
    if (annotation.end_line !== undefined) result.endLine = annotation.end_line;
    if (annotation.annotation_level) result.annotationLevel = annotation.annotation_level;
    if (annotation.message) result.message = annotation.message;
    if (annotation.title) result.title = annotation.title;
    if (annotation.raw_details) result.rawDetails = annotation.raw_details;
    return result;
  });
}

function toGitHubActionsJobs(parsed: z.infer<typeof GitHubActionsJobsSchema>): CheckFailedJob[] {
  return parsed.jobs.map((job) => {
    const result: CheckFailedJob = {
      jobId: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      url: job.html_url,
    };
    if (job.completed_at) result.completedAt = job.completed_at;
    return result;
  });
}

function isFailedActionsJob(job: CheckFailedJob): boolean {
  return (
    job.conclusion === "failure" ||
    job.conclusion === "cancelled" ||
    job.conclusion === "timed_out" ||
    job.conclusion === "action_required"
  );
}

async function getCachedCheckLogTail(input: {
  cwd: string;
  repoPath: string;
  job: CheckFailedJob & { completedAt?: string };
  run: (args: string[], options: GitHubCommandRunnerOptions) => Promise<string>;
  cache: Map<string, { logTail: string; logTruncated: boolean }>;
}): Promise<{ logTail: string; logTruncated: boolean }> {
  const key = `${input.job.jobId}:${input.job.completedAt ?? ""}`;
  const cached = input.cache.get(key);
  if (cached) {
    input.cache.delete(key);
    input.cache.set(key, cached);
    return cached;
  }

  const capped = capCheckLogTail(
    await input.run(["api", `${input.repoPath}/actions/jobs/${input.job.jobId}/logs`], {
      cwd: input.cwd,
    }),
  );
  input.cache.set(key, capped);
  while (input.cache.size > CHECK_LOG_TAIL_CACHE_MAX_ENTRIES) {
    const oldestKey = input.cache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    input.cache.delete(oldestKey);
  }
  return capped;
}

function capCheckLogTail(log: string): { logTail: string; logTruncated: boolean } {
  const lines = log.split("\n");
  let truncated = lines.length > CHECK_LOG_TAIL_MAX_LINES;
  let tail = lines.slice(-CHECK_LOG_TAIL_MAX_LINES).join("\n");

  if (Buffer.byteLength(tail, "utf8") > CHECK_LOG_TAIL_MAX_BYTES) {
    truncated = true;
    tail = utf8SuffixWithinBytes(tail, CHECK_LOG_TAIL_MAX_BYTES);
  }

  return { logTail: tail, logTruncated: truncated };
}

function utf8SuffixWithinBytes(value: string, maxBytes: number): string {
  let lowerBound = 0;
  let upperBound = value.length;

  while (lowerBound < upperBound) {
    const midpoint = Math.floor((lowerBound + upperBound) / 2);
    if (Buffer.byteLength(value.slice(midpoint), "utf8") > maxBytes) {
      lowerBound = midpoint + 1;
    } else {
      upperBound = midpoint;
    }
  }

  return value.slice(lowerBound);
}

function mapTimelineReviewState(
  state: string,
  body: string,
): PullRequestTimelineReviewState | null {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
    case "PENDING":
      return body.trim().length > 0 ? "commented" : null;
    default:
      return body.trim().length > 0 ? "commented" : null;
  }
}

function mapPullRequestTimelineError(error: unknown): PullRequestTimelineError {
  if (error instanceof GitHubCommandError) {
    return {
      kind: classifyPullRequestTimelineError(error.stderr),
      message: error.stderr || error.message,
    };
  }
  if (error instanceof GitHubAuthenticationError) {
    return {
      kind: "forbidden",
      message: error.stderr || error.message,
    };
  }
  return {
    kind: "unknown",
    message: error instanceof Error ? error.message : String(error),
  };
}

function classifyPullRequestTimelineError(stderr: string): PullRequestTimelineErrorKind {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes("could not resolve to a pullrequest") ||
    normalized.includes("pull request not found") ||
    normalized.includes("pullrequest not found")
  ) {
    return "not_found";
  }
  if (
    normalized.includes("forbidden") ||
    normalized.includes("resource not accessible") ||
    normalized.includes("permission") ||
    normalized.includes("access denied") ||
    normalized.includes("requires authentication") ||
    normalized.includes("http 403")
  ) {
    return "forbidden";
  }
  return "unknown";
}

function toCurrentPullRequestStatus(
  item: CurrentPullRequestStatusItem,
  fallbackHeadRefName: string,
): CurrentPullRequestStatus | null {
  if (!item.url || !item.title) {
    return null;
  }
  const repoIdentity = parseGitHubPullRequestRepo(item.url);
  const mergedAt =
    typeof item.mergedAt === "string" && item.mergedAt.trim().length > 0 ? item.mergedAt : null;
  let state: string;
  if (mergedAt !== null) {
    state = "merged";
  } else if (item.state.trim().length > 0) {
    state = item.state.toLowerCase();
  } else {
    state = "";
  }
  const checks = parseStatusCheckRollup(item.statusCheckRollup);
  return {
    ...(typeof item.number === "number" ? { number: item.number } : {}),
    ...(repoIdentity ? { repoOwner: repoIdentity.owner, repoName: repoIdentity.name } : {}),
    url: item.url,
    title: item.title,
    state,
    baseRefName: item.baseRefName,
    headRefName: item.headRefName || fallbackHeadRefName,
    isMerged: mergedAt !== null,
    isDraft: item.isDraft ?? false,
    mergeable: item.mergeable,
    checks,
    checksStatus: computeChecksStatus(checks),
    reviewDecision: mapReviewDecision(item.reviewDecision),
  };
}

async function resolveGitHubEnterpriseHost(cwd: string): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await runGitCommand(["config", "--get", "remote.origin.url"], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: 5_000,
    }));
  } catch {
    return null;
  }

  const location = parseGitRemoteLocation(stdout.trim());
  if (!location) {
    return null;
  }
  let host = location.host;
  if (!isGitHubHost(host) && (location.transport === "scp" || location.transport === "ssh")) {
    // An SSH alias (Host github-work → HostName ghe.acme.com) must be resolved
    // before probing/routing, or gh would be pointed at the alias name.
    host = (await resolveSshHostname(host)) ?? host;
  }
  // github.com (including via ssh alias) needs no GH_HOST — gh defaults there.
  // Only a self-hosted/Enterprise host must be passed explicitly.
  if (isGitHubHost(host)) {
    return null;
  }
  if (await probeGitHubAuthStatusForRouting(host)) {
    return host;
  }
  // A non-cloud (Enterprise) host that isn't authenticated must NOT resolve to
  // "no host": that would let gh default to github.com and silently query the
  // wrong server for a GHES workspace. Surface the auth gap instead, so read
  // paths (and authState) report unauthenticated rather than hitting github.com.
  throw new GitHubAuthenticationError({
    stderr: `GitHub CLI is not authenticated for host ${host}`,
  });
}

function parseGitHubPullRequestRepo(url: string): { owner: string; name: string } | null {
  try {
    const parsed = new URL(url);
    // Host-agnostic on purpose: a GitHub Enterprise PR URL carries the instance
    // host, and the owner/name still live in the same `/owner/name/pull/N` path.
    const [owner, name, kind] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !name || kind !== "pull") {
      return null;
    }
    return { owner, name };
  } catch {
    return null;
  }
}

export function parseStatusCheckRollup(value: unknown, nowMs = Date.now()): PullRequestCheck[] {
  const directContexts = PullRequestStatusCheckRollupArraySchema.safeParse(value);
  if (!directContexts.success) {
    const legacyContexts = LegacyPullRequestStatusCheckRollupSchema.safeParse(value);
    if (!legacyContexts.success) {
      return [];
    }
    return parseStatusCheckRollup(legacyContexts.data.contexts, nowMs);
  }

  const dedupedChecks = new Map<string, PullRequestCheck & { recency: number }>();
  for (const entry of directContexts.data) {
    const parsed = PullRequestStatusCheckRollupNodeSchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    const check = buildPullRequestCheck(parsed.data, nowMs);
    if (!check) {
      continue;
    }
    const existing = dedupedChecks.get(check.name);
    if (!existing || check.recency > existing.recency) {
      dedupedChecks.set(check.name, check);
    }
  }

  return Array.from(dedupedChecks.values(), ({ recency: _recency, ...check }) => check);
}

function buildPullRequestCheck(
  context: z.infer<typeof PullRequestStatusCheckRollupNodeSchema>,
  nowMs: number,
): (PullRequestCheck & { recency: number }) | null {
  if (context.__typename === "CheckRun") {
    return {
      name: context.name,
      status: mapCheckRunStatus(context.status, context.conclusion),
      url: typeof context.detailsUrl === "string" ? context.detailsUrl : null,
      ...(typeof context.workflowName === "string" && context.workflowName.trim().length > 0
        ? { workflow: context.workflowName }
        : {}),
      ...(typeof context.databaseId === "number" ? { checkRunId: context.databaseId } : {}),
      ...(typeof context.checkSuite?.workflowRun?.databaseId === "number"
        ? { workflowRunId: context.checkSuite.workflowRun.databaseId }
        : {}),
      ...formatCheckRunDuration(context, nowMs),
      recency: getCheckRunRecency(context),
    };
  }
  if (context.__typename === "StatusContext") {
    return {
      name: context.context,
      status: mapStatusContextState(context.state),
      url: typeof context.targetUrl === "string" ? context.targetUrl : null,
      recency: getStatusContextRecency(context),
    };
  }
  return null;
}

function mapCheckRunStatus(status: unknown, conclusion: unknown): PullRequestCheckStatus {
  if (status !== "COMPLETED") {
    return "pending";
  }
  switch (conclusion) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipped";
    default:
      return "pending";
  }
}

function mapStatusContextState(state: unknown): PullRequestCheckStatus {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "EXPECTED":
    case "PENDING":
      return "pending";
    default:
      return "pending";
  }
}

function getCheckRunRecency(context: PullRequestCheckRunNode): number {
  const workflowRunId = context.checkSuite?.workflowRun?.databaseId;
  if (typeof workflowRunId === "number") {
    return workflowRunId;
  }
  return parseOptionalTime(context.completedAt ?? context.startedAt ?? null);
}

/**
 * How long the check ran for. A finished run measures to its completion; a run still
 * going measures to now, so a client can say how long it has been waiting instead of
 * showing nothing. Raw timestamps never reach the client, so this is where the choice
 * between the two has to be made.
 */
function formatCheckRunDuration(
  context: PullRequestCheckRunNode,
  nowMs: number,
): { duration?: string } {
  const startedAt = parseOptionalTime(context.startedAt ?? null);
  if (startedAt <= 0) {
    return {};
  }
  const completedAt = parseOptionalTime(context.completedAt ?? null);
  const endedAt = completedAt > 0 ? completedAt : nowMs;
  if (endedAt < startedAt) {
    return {};
  }
  const durationSeconds = Math.floor((endedAt - startedAt) / 1_000);
  return { duration: formatDurationSeconds(durationSeconds) };
}

function formatDurationSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

function getStatusContextRecency(context: PullRequestStatusContextNode): number {
  return parseOptionalTime(context.createdAt ?? null);
}

function mapReviewDecision(value: unknown): PullRequestReviewDecision {
  const reviewDecision = PullRequestReviewDecisionSchema.parse(value);
  if (reviewDecision === "APPROVED") {
    return "approved";
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    return "changes_requested";
  }
  if (reviewDecision === "REVIEW_REQUIRED") {
    return "pending";
  }
  return null;
}
