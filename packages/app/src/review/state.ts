import { z } from "zod";

export type ReviewDraftMode = "uncommitted" | "base";
export type ReviewDraftSide = "old" | "new";

export interface ReviewDraftComment {
  id: string;
  filePath: string;
  side: ReviewDraftSide;
  lineNumber: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

// A manual mode selection is valid only while the checkout's dirty state matches the
// value at the time of selection. serverId/cwd identify the checkout so the override can
// be expired when its dirty state changes (see expireStaleDiffModeOverridesInState).
export interface DiffModeOverride {
  serverId: string;
  cwd: string;
  mode: ReviewDraftMode;
  isDirtyAtSelection: boolean;
}

export interface ReviewDraftStoreState {
  drafts: Record<string, ReviewDraftComment[]>;
  // In-memory only — not persisted. Keyed by scope key.
  diffModeOverrides: Record<string, DiffModeOverride>;
}

// Only drafts are persisted; diffModeOverrides is intentionally excluded.
export interface SerializedReviewDraftState {
  drafts: Record<string, ReviewDraftComment[]>;
}

const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const ReviewDraftCommentSchema: z.ZodType<ReviewDraftComment> = z.strictObject({
  id: z.string(),
  filePath: z.string(),
  side: z.enum(["old", "new"]),
  lineNumber: z.number().int().positive(),
  body: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const SerializedReviewDraftStateSchema: z.ZodType<SerializedReviewDraftState> =
  z.strictObject({
    drafts: z.record(z.string(), z.array(ReviewDraftCommentSchema)),
  });

export function setDiffModeOverrideInState(
  state: ReviewDraftStoreState,
  input: { scopeKey: string; override: DiffModeOverride },
): ReviewDraftStoreState {
  return {
    ...state,
    diffModeOverrides: {
      ...state.diffModeOverrides,
      [input.scopeKey]: input.override,
    },
  };
}

// Drops every override for the checkout whose dirty state no longer matches the value it
// was selected under. Called whenever a checkout status enters the app (push or fetch),
// so expiry does not depend on any screen being mounted.
export function expireStaleDiffModeOverridesInState(
  state: ReviewDraftStoreState,
  input: { serverId: string; cwd: string; isDirty: boolean },
): ReviewDraftStoreState {
  const staleScopeKeys = Object.entries(state.diffModeOverrides)
    .filter(
      ([, override]) =>
        override.serverId === input.serverId &&
        override.cwd === input.cwd &&
        override.isDirtyAtSelection !== input.isDirty,
    )
    .map(([scopeKey]) => scopeKey);
  if (staleScopeKeys.length === 0) {
    return state;
  }
  const next = { ...state.diffModeOverrides };
  for (const scopeKey of staleScopeKeys) {
    delete next[scopeKey];
  }
  return { ...state, diffModeOverrides: next };
}

// Pure read — returns the effective mode without mutating state. The staleness check is
// kept even though stale overrides are expired at the data boundary: a render can observe
// a fresh dirty state before the expiry lands, and resolution must be correct under any
// interleaving.
export function resolveDiffMode(input: {
  override: DiffModeOverride | undefined;
  hasUncommittedChanges: boolean;
}): ReviewDraftMode {
  const { override, hasUncommittedChanges } = input;
  if (override && override.isDirtyAtSelection === hasUncommittedChanges) {
    return override.mode;
  }
  return hasUncommittedChanges ? "uncommitted" : "base";
}

export function addCommentToState(
  state: ReviewDraftStoreState,
  input: { key: string; comment: ReviewDraftComment },
): ReviewDraftStoreState {
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [input.key]: [...(state.drafts[input.key] ?? []), input.comment],
    },
  };
}

export function updateCommentInState(
  state: ReviewDraftStoreState,
  input: {
    key: string;
    id: string;
    updates: Partial<Pick<ReviewDraftComment, "body">>;
    updatedAt: string;
  },
): ReviewDraftStoreState {
  const comments = state.drafts[input.key] ?? [];
  if (!comments.some((comment) => comment.id === input.id)) {
    return state;
  }
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [input.key]: comments.map((comment) =>
        applyCommentUpdates(comment, input.id, input.updates, input.updatedAt),
      ),
    },
  };
}

export function deleteCommentFromState(
  state: ReviewDraftStoreState,
  input: { key: string; id: string },
): ReviewDraftStoreState {
  const comments = state.drafts[input.key] ?? [];
  if (!comments.some((comment) => comment.id === input.id)) {
    return state;
  }
  return {
    ...state,
    drafts: {
      ...state.drafts,
      [input.key]: comments.filter((comment) => comment.id !== input.id),
    },
  };
}

export function clearReviewInState(
  state: ReviewDraftStoreState,
  input: { key: string },
): ReviewDraftStoreState {
  if (!state.drafts[input.key]) {
    return state;
  }
  const nextDrafts = { ...state.drafts };
  delete nextDrafts[input.key];
  return { ...state, drafts: nextDrafts };
}

export function serializeReviewDraftState(
  state: ReviewDraftStoreState,
): SerializedReviewDraftState {
  return {
    drafts: state.drafts,
  };
}

export function normalizePersistedState(state: unknown): ReviewDraftStoreState {
  const result = SerializedReviewDraftStateSchema.safeParse(state);
  return {
    drafts: result.success ? result.data.drafts : {},
    diffModeOverrides: {},
  };
}

function applyCommentUpdates(
  comment: ReviewDraftComment,
  targetId: string,
  updates: Partial<Pick<ReviewDraftComment, "body">>,
  updatedAt: string,
): ReviewDraftComment {
  if (comment.id !== targetId) {
    return comment;
  }
  return {
    id: comment.id,
    filePath: comment.filePath,
    side: comment.side,
    lineNumber: comment.lineNumber,
    body: updates.body ?? comment.body,
    createdAt: comment.createdAt,
    updatedAt,
  };
}
