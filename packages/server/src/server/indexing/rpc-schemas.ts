import { z } from "zod";
import {
  EmbeddingProviderSchema,
  ExposeToEntrySchema,
  IndexingStateSchema,
  IndexingStatusSchema,
} from "./types.js";

// ---------------------------------------------------------------------------
// Requests (client → server)
// ---------------------------------------------------------------------------

export const IndexingListRequestSchema = z.object({
  type: z.literal("indexing/list"),
  requestId: z.string(),
});

export const IndexingGetRequestSchema = z.object({
  type: z.literal("indexing/get"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const IndexingSetEnabledRequestSchema = z.object({
  type: z.literal("indexing/set-enabled"),
  requestId: z.string(),
  workspaceId: z.string(),
  enabled: z.boolean(),
});

export const IndexingSetExposeToRequestSchema = z.object({
  type: z.literal("indexing/set-expose-to"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  entry: ExposeToEntrySchema.nullable(),
});

export const IndexingSetEmbeddingProviderRequestSchema = z.object({
  type: z.literal("indexing/set-embedding-provider"),
  requestId: z.string(),
  workspaceId: z.string(),
  provider: EmbeddingProviderSchema.nullable(),
});

export const IndexingSetWatchlistRequestSchema = z.object({
  type: z.literal("indexing/set-watchlist"),
  requestId: z.string(),
  workspaceId: z.string(),
  watchlist: z.array(z.string()),
});

export const IndexingDetectRequestSchema = z.object({
  type: z.literal("indexing/detect"),
  requestId: z.string(),
  force: z.boolean().optional(),
});

export const IndexingInstallRequestSchema = z.object({
  type: z.literal("indexing/install"),
  requestId: z.string(),
});

export const IndexingToolsListRequestSchema = z.object({
  type: z.literal("indexing/tools/list"),
  requestId: z.string(),
});

export const IndexingReindexRequestSchema = z.object({
  type: z.literal("indexing/reindex"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const IndexingCancelReindexRequestSchema = z.object({
  type: z.literal("indexing/cancel-reindex"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const IndexingRestartSubprocessRequestSchema = z.object({
  type: z.literal("indexing/restart-subprocess"),
  requestId: z.string(),
});

export const IndexingStderrTailRequestSchema = z.object({
  type: z.literal("indexing/stderr-tail"),
  requestId: z.string(),
});

// ---------------------------------------------------------------------------
// Response payloads
// ---------------------------------------------------------------------------

export const IndexingWorkspaceEntrySchema = z.object({
  workspaceId: z.string(),
  indexing: IndexingStateSchema.optional(),
});

export const IndexingToolDetectionPayloadSchema = z.object({
  codeReviewGraph: z.object({
    name: z.string(),
    installed: z.boolean(),
    path: z.string().optional(),
    version: z.string().optional(),
    meetsMinimumVersion: z.boolean().optional(),
  }),
  pipx: z.object({
    name: z.string(),
    installed: z.boolean(),
    path: z.string().optional(),
    version: z.string().optional(),
    meetsMinimumVersion: z.boolean().optional(),
  }),
  python3: z.object({
    name: z.string(),
    installed: z.boolean(),
    path: z.string().optional(),
    version: z.string().optional(),
    meetsMinimumVersion: z.boolean().optional(),
  }),
  canInstall: z.boolean(),
  suggestedInstall: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Responses (server → client)
// ---------------------------------------------------------------------------

const baseResponseError = z.object({
  requestId: z.string(),
  error: z.string().nullable(),
});

export const IndexingListResponseSchema = z.object({
  type: z.literal("indexing/list/response"),
  payload: baseResponseError.extend({
    entries: z.array(IndexingWorkspaceEntrySchema),
  }),
});

export const IndexingGetResponseSchema = z.object({
  type: z.literal("indexing/get/response"),
  payload: baseResponseError.extend({
    entry: IndexingWorkspaceEntrySchema.nullable(),
  }),
});

export const IndexingStateResponseSchema = z.object({
  type: z.literal("indexing/state/response"),
  payload: baseResponseError.extend({
    workspaceId: z.string(),
    indexing: IndexingStateSchema.nullable(),
  }),
});

export const IndexingDetectResponseSchema = z.object({
  type: z.literal("indexing/detect/response"),
  payload: baseResponseError.extend({
    detection: IndexingToolDetectionPayloadSchema.nullable(),
  }),
});

// ---------------------------------------------------------------------------
// Server-push events (no requestId)
// ---------------------------------------------------------------------------

export const IndexingToolsListResponseSchema = z.object({
  type: z.literal("indexing/tools/list/response"),
  payload: baseResponseError.extend({
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
});

export const IndexingStatusEventSchema = z.object({
  type: z.literal("indexing/status"),
  payload: z.object({
    workspaceId: z.string(),
    status: IndexingStatusSchema,
  }),
});

export const IndexingCancelReindexResponseSchema = z.object({
  type: z.literal("indexing/cancel-reindex/response"),
  payload: baseResponseError.extend({
    cancelled: z.boolean(),
  }),
});

export const IndexingRestartSubprocessResponseSchema = z.object({
  type: z.literal("indexing/restart-subprocess/response"),
  payload: baseResponseError.extend({
    restarted: z.boolean(),
  }),
});

export const IndexingStderrTailResponseSchema = z.object({
  type: z.literal("indexing/stderr-tail/response"),
  payload: baseResponseError.extend({
    text: z.string(),
  }),
});

/**
 * Stream event for an in-progress install. Shape mirrors InstallEvent in
 * `installer.ts` but flattened for WebSocket transport.
 */
export const IndexingInstallEventSchema = z.object({
  type: z.literal("indexing/install/event"),
  payload: z.object({
    requestId: z.string(),
    event: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("plan"),
        strategy: z.object({
          kind: z.enum(["pipx", "brew-then-pipx", "python3-bootstrap-pipx", "unsupported"]),
          reason: z.string().optional(),
        }),
      }),
      z.object({
        type: z.literal("step-started"),
        command: z.string(),
        args: z.array(z.string()),
        index: z.number().int().nonnegative(),
        total: z.number().int().positive(),
      }),
      z.object({
        type: z.literal("step-output"),
        stream: z.enum(["stdout", "stderr"]),
        text: z.string(),
      }),
      z.object({
        type: z.literal("step-completed"),
        command: z.string(),
        exitCode: z.number().nullable(),
      }),
      z.object({
        type: z.literal("completed"),
        success: z.boolean(),
        error: z.string().optional(),
      }),
    ]),
  }),
});

/**
 * Push event: crg subprocess state transitions (stopped / starting / running /
 * restarting / failed), with restart count and last error. Emitted whenever
 * the daemon's CrgProcessManager transitions phase. Used by the app to show
 * subprocess health in the indexing status bar.
 */
export const IndexingProcessStateEventSchema = z.object({
  type: z.literal("indexing/process-state"),
  payload: z.object({
    phase: z.enum(["stopped", "starting", "running", "restarting", "failed"]),
    pid: z.number().int().optional(),
    startedAt: z.number().optional(),
    restartCount: z.number().int().nonnegative(),
    lastError: z.string().optional(),
  }),
});

/**
 * Push event: crg MCP tool manifest refreshed. Signals the app to invalidate
 * its cached tool list so it shows any newly-available tools without waiting
 * for the staleTime to expire.
 */
export const IndexingToolsChangedEventSchema = z.object({
  type: z.literal("indexing/tools-changed"),
  payload: z.object({
    workspaceId: z.string().optional(),
    agentId: z.string().nullable().optional(),
  }),
});

/**
 * Push event: fs-watcher observed changes in a workspace and triggered a
 * reindex, or hit an error while watching.
 */
export const IndexingFsTriggerEventSchema = z.object({
  type: z.literal("indexing/fs-trigger"),
  payload: z.union([
    z.object({
      kind: z.literal("change"),
      workspaceId: z.string(),
      changedPaths: z.array(z.string()),
    }),
    z.object({
      kind: z.literal("error"),
      workspaceId: z.string(),
      error: z.string(),
    }),
  ]),
});

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type IndexingListRequest = z.infer<typeof IndexingListRequestSchema>;
export type IndexingGetRequest = z.infer<typeof IndexingGetRequestSchema>;
export type IndexingSetEnabledRequest = z.infer<typeof IndexingSetEnabledRequestSchema>;
export type IndexingSetExposeToRequest = z.infer<typeof IndexingSetExposeToRequestSchema>;
export type IndexingSetEmbeddingProviderRequest = z.infer<
  typeof IndexingSetEmbeddingProviderRequestSchema
>;
export type IndexingSetWatchlistRequest = z.infer<typeof IndexingSetWatchlistRequestSchema>;
export type IndexingDetectRequest = z.infer<typeof IndexingDetectRequestSchema>;
export type IndexingInstallRequest = z.infer<typeof IndexingInstallRequestSchema>;
export type IndexingToolsListRequest = z.infer<typeof IndexingToolsListRequestSchema>;
export type IndexingReindexRequest = z.infer<typeof IndexingReindexRequestSchema>;
export type IndexingCancelReindexRequest = z.infer<typeof IndexingCancelReindexRequestSchema>;
export type IndexingRestartSubprocessRequest = z.infer<
  typeof IndexingRestartSubprocessRequestSchema
>;
export type IndexingStderrTailRequest = z.infer<typeof IndexingStderrTailRequestSchema>;

export type IndexingListResponse = z.infer<typeof IndexingListResponseSchema>;
export type IndexingToolsListResponse = z.infer<typeof IndexingToolsListResponseSchema>;
export type IndexingGetResponse = z.infer<typeof IndexingGetResponseSchema>;
export type IndexingStateResponse = z.infer<typeof IndexingStateResponseSchema>;
export type IndexingDetectResponse = z.infer<typeof IndexingDetectResponseSchema>;
export type IndexingCancelReindexResponse = z.infer<typeof IndexingCancelReindexResponseSchema>;
export type IndexingRestartSubprocessResponse = z.infer<
  typeof IndexingRestartSubprocessResponseSchema
>;
export type IndexingStderrTailResponse = z.infer<typeof IndexingStderrTailResponseSchema>;
export type IndexingStatusEvent = z.infer<typeof IndexingStatusEventSchema>;
export type IndexingInstallEvent = z.infer<typeof IndexingInstallEventSchema>;
export type IndexingProcessStateEvent = z.infer<typeof IndexingProcessStateEventSchema>;
export type IndexingToolsChangedEvent = z.infer<typeof IndexingToolsChangedEventSchema>;
export type IndexingFsTriggerEvent = z.infer<typeof IndexingFsTriggerEventSchema>;

export type IndexingInboundRequest =
  | IndexingListRequest
  | IndexingGetRequest
  | IndexingSetEnabledRequest
  | IndexingSetExposeToRequest
  | IndexingSetEmbeddingProviderRequest
  | IndexingSetWatchlistRequest
  | IndexingDetectRequest
  | IndexingInstallRequest
  | IndexingToolsListRequest
  | IndexingReindexRequest
  | IndexingCancelReindexRequest
  | IndexingRestartSubprocessRequest
  | IndexingStderrTailRequest;

export type IndexingOutboundMessage =
  | IndexingListResponse
  | IndexingGetResponse
  | IndexingStateResponse
  | IndexingDetectResponse
  | IndexingToolsListResponse
  | IndexingCancelReindexResponse
  | IndexingRestartSubprocessResponse
  | IndexingStderrTailResponse
  | IndexingStatusEvent
  | IndexingInstallEvent
  | IndexingProcessStateEvent
  | IndexingToolsChangedEvent
  | IndexingFsTriggerEvent;
