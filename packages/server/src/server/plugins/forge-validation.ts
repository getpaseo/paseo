import {
  PLUGIN_FORGE_SERVICE_METHODS,
  type PluginForgeServerProviderDescriptor,
  type PluginForgeServiceMethod,
} from "@getpaseo/plugin/server";
import { normalizeHost } from "@getpaseo/protocol/git-remote";
import { z } from "zod";

const ForgeProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const RequiredTextSchema = z.string().trim().min(1);

const ForgeDefinitionSchema = z
  .object({
    id: ForgeProviderIdSchema,
    displayName: RequiredTextSchema,
    changeRequestAbbrev: RequiredTextSchema,
    changeRequestNoun: RequiredTextSchema,
    changeRequestNumberPrefix: RequiredTextSchema,
    issueNumberPrefix: RequiredTextSchema,
    signIn: z
      .object({
        cli: RequiredTextSchema,
        command: RequiredTextSchema,
        hostnameFlag: RequiredTextSchema.optional(),
      })
      .nullable(),
    cloudHosts: z.array(RequiredTextSchema).optional(),
  })
  .superRefine((definition, context) => {
    const normalizedHosts = (definition.cloudHosts ?? []).map(normalizeHost);
    if (normalizedHosts.some((host) => host.length === 0)) {
      context.addIssue({ code: "custom", message: "Forge cloud hosts cannot be empty" });
    }
    if (new Set(normalizedHosts).size !== normalizedHosts.length) {
      context.addIssue({ code: "custom", message: "Forge cloud hosts must be unique" });
    }
  });

const ForgeServiceMethodSchema = z.enum(PLUGIN_FORGE_SERVICE_METHODS);
const OptionalForgeServiceMethods = new Set<PluginForgeServiceMethod>([
  "defaultCheckoutRefs",
  "buildPrLocalBranchName",
  "dispose",
]);
const RequiredForgeServiceMethods = PLUGIN_FORGE_SERVICE_METHODS.filter(
  (method) => !OptionalForgeServiceMethods.has(method),
);

const ForgeProviderDescriptorSchema = z
  .object({
    definition: ForgeDefinitionSchema,
    methods: z.array(ForgeServiceMethodSchema),
    authProbeCanThrow: z.boolean(),
    supportsCrossRepoCheckoutWithoutRefs: z.boolean(),
    hasProbeHost: z.boolean(),
  })
  .superRefine((descriptor, context) => {
    const methods = new Set(descriptor.methods);
    if (methods.size !== descriptor.methods.length) {
      context.addIssue({ code: "custom", message: "Forge provider methods must be unique" });
    }
    for (const method of RequiredForgeServiceMethods) {
      if (!methods.has(method)) {
        context.addIssue({
          code: "custom",
          message: `Forge provider must implement ${method}`,
        });
      }
    }
  });

const ForgeProviderDescriptorsSchema = z
  .array(ForgeProviderDescriptorSchema)
  .superRefine((descriptors, context) => {
    const ids = descriptors.map((descriptor) => descriptor.definition.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Forge provider ids must be unique" });
    }
  });

const PullRequestSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  projectPath: z.string().optional(),
  baseRefName: z.string(),
  headRefName: z.string(),
  labels: z.array(z.string()),
  updatedAt: z.string(),
});

const IssueSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  projectPath: z.string().optional(),
  labels: z.array(z.string()),
  updatedAt: z.string(),
});

const PullRequestCheckoutRefSchema = z.object({
  remoteName: z.string().optional(),
  remoteUrl: z.string().optional(),
  remoteRef: z.string(),
});

const PullRequestCheckoutTargetSchema = z.object({
  number: z.number(),
  baseRefName: z.string(),
  headRefName: z.string(),
  checkoutRefs: z.array(PullRequestCheckoutRefSchema).optional(),
  headOwnerLogin: z.string().nullable(),
  preferredPushUrl: z.string().optional(),
  headRepositorySshUrl: z.string().nullable(),
  headRepositoryUrl: z.string().nullable(),
  isCrossRepository: z.boolean(),
});

const PullRequestCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["pending", "success", "failure", "cancelled", "skipped"]),
  url: z.string().nullable(),
  workflow: z.string().optional(),
  duration: z.string().optional(),
  checkRunId: z.number().optional(),
  workflowRunId: z.number().optional(),
  traits: z.array(z.string()).optional(),
});

const ForgeSpecificStatusFactsSchema = z.object({ forge: z.string() }).catchall(z.unknown());

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive();
const ForgeReadInputSchema = z.union([
  z.object({ force: z.literal(true), reason: NonEmptyStringSchema }),
  z.object({ force: z.literal(false).optional(), reason: z.string().optional() }),
]);

function forgeReadInputSchema(shape: z.ZodRawShape): z.ZodType {
  return z.object(shape).and(ForgeReadInputSchema);
}

const PullRequestCommandStatusSchema = z.object({
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).optional(),
  forgeSpecific: ForgeSpecificStatusFactsSchema.optional(),
});

const ForgeMergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
const ForgeSearchKindSchema = z.enum([
  "issue",
  "change_request",
  "github-issue",
  "github-pr",
  "pr",
]);

const CurrentPullRequestStatusSchema = z.object({
  number: z.number().optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  projectPath: z.string().optional(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  isMerged: z.boolean(),
  isDraft: z.boolean().optional(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  checks: z.array(PullRequestCheckSchema),
  checksStatus: z.enum(["none", "pending", "success", "failure"]),
  reviewDecision: z.enum(["approved", "changes_requested", "pending"]).nullable(),
  forgeSpecific: ForgeSpecificStatusFactsSchema.optional(),
});

const PullRequestTimelineItemBaseSchema = z.object({
  id: z.string(),
  author: z.string(),
  authorUrl: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  body: z.string(),
  createdAt: z.number(),
  url: z.string(),
});

const PullRequestTimelineItemSchema = z.discriminatedUnion("kind", [
  PullRequestTimelineItemBaseSchema.extend({
    kind: z.literal("review"),
    reviewState: z.enum(["approved", "changes_requested", "commented"]),
  }),
  PullRequestTimelineItemBaseSchema.extend({
    kind: z.literal("comment"),
    reviewId: z.string().optional(),
    threadId: z.string().optional(),
    threadIsResolved: z.boolean().optional(),
    location: z
      .object({
        path: z.string(),
        line: z.number().optional(),
        startLine: z.number().optional(),
        threadId: z.string().optional(),
        isResolved: z.boolean().optional(),
        isOutdated: z.boolean().optional(),
      })
      .optional(),
  }),
]);

const PullRequestTimelineSchema = z.object({
  prNumber: z.number(),
  repoOwner: z.string(),
  repoName: z.string(),
  items: z.array(PullRequestTimelineItemSchema),
  truncated: z.boolean(),
  error: z
    .object({
      kind: z.enum(["not_found", "forbidden", "unknown"]),
      message: z.string(),
    })
    .nullable(),
});

const CheckFailedJobSchema = z.object({
  jobId: z.number(),
  name: z.string(),
  status: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  completedAt: z.string().optional(),
  logTail: z.string().optional(),
  logTruncated: z.boolean().optional(),
});

const PipelineJobSchema = z.object({
  id: z.number(),
  name: z.string(),
  stage: z.string(),
  status: z.enum([
    "success",
    "failed",
    "running",
    "pending",
    "canceled",
    "skipped",
    "manual",
    "created",
    "unknown",
  ]),
  rawStatus: z.string(),
  url: z.string().nullable(),
  allowFailure: z.boolean(),
  durationSeconds: z.number().nullable(),
});

const PipelineDetailsSchema = z.object({
  id: z.number(),
  status: PipelineJobSchema.shape.status,
  rawStatus: z.string(),
  url: z.string().nullable(),
  ref: z.string().nullable(),
  sha: z.string().nullable(),
  stages: z.array(
    z.object({
      name: z.string(),
      status: PipelineJobSchema.shape.status,
      jobs: z.array(PipelineJobSchema),
    }),
  ),
});

const CheckDetailsSchema = z.object({
  checkRunId: z.number(),
  workflowRunId: z.number().nullable().optional(),
  name: z.string(),
  status: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  detailsUrl: z.string().nullable().optional(),
  output: z
    .object({
      title: z.string().nullable().optional(),
      summary: z.string().nullable().optional(),
      text: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  annotations: z.array(
    z.object({
      path: z.string().optional(),
      startLine: z.number().optional(),
      endLine: z.number().optional(),
      annotationLevel: z.string().optional(),
      message: z.string().optional(),
      title: z.string().optional(),
      rawDetails: z.string().optional(),
    }),
  ),
  failedJobs: z.array(CheckFailedJobSchema),
  truncated: z.boolean(),
  pipeline: PipelineDetailsSchema.nullable().optional(),
});

const ForgeAuthStateSchema = z.enum([
  "authenticated",
  "unauthenticated",
  "cli_missing",
  "no_remote",
  "error",
]);

const SearchResultSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(["issue", "change_request"]),
      forge: z.string().optional(),
      number: z.number(),
      title: z.string(),
      url: z.string(),
      state: z.string(),
      body: z.string().nullable(),
      labels: z.array(z.string()),
      projectPath: z.string().optional(),
      baseRefName: z.string().nullable().optional(),
      headRefName: z.string().nullable().optional(),
      updatedAt: z.string().optional(),
    }),
  ),
  featuresEnabled: z.boolean(),
  authState: ForgeAuthStateSchema,
  githubFeaturesEnabled: z.boolean().optional(),
});

const SuccessSchema = z.object({ success: z.literal(true) });

const ForgeInputSchemas: Record<PluginForgeServiceMethod | "probeHost", z.ZodType> = {
  listPullRequests: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    query: z.string().optional(),
    limit: PositiveIntegerSchema.optional(),
  }),
  listIssues: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    query: z.string().optional(),
    limit: PositiveIntegerSchema.optional(),
  }),
  getPullRequest: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    number: PositiveIntegerSchema,
  }),
  getPullRequestHeadRef: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    number: PositiveIntegerSchema,
  }),
  getPullRequestCheckoutTarget: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    number: PositiveIntegerSchema,
  }),
  defaultCheckoutRefs: z.object({
    changeRequestNumber: PositiveIntegerSchema,
    headRef: NonEmptyStringSchema,
  }),
  buildPrLocalBranchName: z.object({
    headRef: NonEmptyStringSchema,
    checkoutTarget: PullRequestCheckoutTargetSchema,
  }),
  getCurrentPullRequestStatus: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    headRef: NonEmptyStringSchema,
    headSha: NonEmptyStringSchema.optional(),
    headRepositoryOwner: NonEmptyStringSchema.optional(),
  }),
  getPullRequestTimeline: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    prNumber: PositiveIntegerSchema,
    repoOwner: NonEmptyStringSchema,
    repoName: NonEmptyStringSchema,
  }),
  getCheckDetails: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    repoOwner: NonEmptyStringSchema.optional(),
    repoName: NonEmptyStringSchema.optional(),
    checkRunId: PositiveIntegerSchema.optional(),
    workflowRunId: PositiveIntegerSchema.optional(),
    changeRequestNumber: PositiveIntegerSchema.optional(),
  }),
  searchIssuesAndPrs: forgeReadInputSchema({
    cwd: NonEmptyStringSchema,
    query: z.string(),
    limit: PositiveIntegerSchema.optional(),
    kinds: z.array(ForgeSearchKindSchema).optional(),
  }),
  createPullRequest: z.object({
    cwd: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    head: NonEmptyStringSchema,
    base: NonEmptyStringSchema,
    body: z.string().optional(),
  }),
  mergePullRequest: z.object({
    cwd: NonEmptyStringSchema,
    prNumber: PositiveIntegerSchema,
    mergeMethod: ForgeMergeMethodSchema,
    status: PullRequestCommandStatusSchema.nullable().optional(),
  }),
  enablePullRequestAutoMerge: z.object({
    cwd: NonEmptyStringSchema,
    prNumber: PositiveIntegerSchema,
    mergeMethod: ForgeMergeMethodSchema,
    status: PullRequestCommandStatusSchema.nullable().optional(),
  }),
  disablePullRequestAutoMerge: z.object({
    cwd: NonEmptyStringSchema,
    prNumber: PositiveIntegerSchema,
    status: PullRequestCommandStatusSchema.nullable().optional(),
  }),
  isAuthenticated: forgeReadInputSchema({ cwd: NonEmptyStringSchema }),
  invalidate: z.object({ cwd: NonEmptyStringSchema }),
  dispose: z.undefined(),
  probeHost: NonEmptyStringSchema,
};

const ForgeResultSchemas: Record<PluginForgeServiceMethod | "probeHost", z.ZodType> = {
  listPullRequests: z.array(PullRequestSummarySchema),
  listIssues: z.array(IssueSummarySchema),
  getPullRequest: PullRequestSummarySchema,
  getPullRequestHeadRef: z.string(),
  getPullRequestCheckoutTarget: PullRequestCheckoutTargetSchema,
  defaultCheckoutRefs: z.array(PullRequestCheckoutRefSchema),
  buildPrLocalBranchName: z.string().optional(),
  getCurrentPullRequestStatus: CurrentPullRequestStatusSchema.nullable(),
  getPullRequestTimeline: PullRequestTimelineSchema,
  getCheckDetails: CheckDetailsSchema,
  searchIssuesAndPrs: SearchResultSchema,
  createPullRequest: z.object({ url: z.string(), number: z.number() }),
  mergePullRequest: SuccessSchema,
  enablePullRequestAutoMerge: SuccessSchema,
  disablePullRequestAutoMerge: SuccessSchema,
  isAuthenticated: z.boolean(),
  invalidate: z.undefined(),
  dispose: z.undefined(),
  probeHost: z.boolean(),
};

export function parsePluginForgeProviderDescriptors(
  value: unknown,
): PluginForgeServerProviderDescriptor[] {
  return ForgeProviderDescriptorsSchema.parse(value) as PluginForgeServerProviderDescriptor[];
}

export function parsePluginForgeInput(method: "probeHost", value: unknown): string;
export function parsePluginForgeInput(
  method: PluginForgeServiceMethod | "probeHost",
  value: unknown,
): unknown;
export function parsePluginForgeInput(
  method: PluginForgeServiceMethod | "probeHost",
  value: unknown,
): unknown {
  const parsed = ForgeInputSchemas[method].safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Plugin forge ${method} received invalid input: ${parsed.error.message}`);
}

export function parsePluginForgeResult(
  method: PluginForgeServiceMethod | "probeHost",
  value: unknown,
): unknown {
  const parsed = ForgeResultSchemas[method].safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`Plugin forge ${method} returned invalid output: ${parsed.error.message}`);
}
