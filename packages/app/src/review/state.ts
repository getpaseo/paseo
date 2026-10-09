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

export interface ReviewDraftStoreState {
  drafts: Record<string, ReviewDraftComment[]>;
}

export interface SerializedReviewDraftState {
  drafts: Record<string, ReviewDraftComment[]>;
  activeModesByScope?: Record<string, ReviewDraftMode>;
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
    // COMPAT(reviewDraftModes): v1 persisted this field; v2 discards it during migration.
    activeModesByScope: z.record(z.string(), z.enum(["uncommitted", "base"])).optional(),
  });

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
