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
  activeModesByScope: Record<string, ReviewDraftMode>;
}

export interface SerializedReviewDraftState {
  drafts: Record<string, ReviewDraftComment[]>;
  activeModesByScope: Record<string, ReviewDraftMode>;
}

export function setActiveModeInState(
  state: ReviewDraftStoreState,
  input: { scopeKey: string; mode: ReviewDraftMode },
): ReviewDraftStoreState {
  if (state.activeModesByScope[input.scopeKey] === input.mode) {
    return state;
  }
  return {
    ...state,
    activeModesByScope: {
      ...state.activeModesByScope,
      [input.scopeKey]: input.mode,
    },
  };
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
    activeModesByScope: state.activeModesByScope,
  };
}

export function normalizePersistedState(state: unknown): ReviewDraftStoreState {
  if (!state || typeof state !== "object") {
    return { drafts: {}, activeModesByScope: {} };
  }
  const persisted = state as { drafts?: unknown; activeModesByScope?: unknown };
  const drafts = persisted.drafts;
  if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) {
    return { drafts: {}, activeModesByScope: {} };
  }

  const normalized: Record<string, ReviewDraftComment[]> = {};
  for (const [key, value] of Object.entries(drafts)) {
    if (!Array.isArray(value)) {
      continue;
    }
    normalized[key] = value.filter((comment): comment is ReviewDraftComment =>
      isReviewDraftComment(comment),
    );
  }

  const activeModesByScope: Record<string, ReviewDraftMode> = {};
  const persistedActiveModes = persisted.activeModesByScope;
  if (
    persistedActiveModes &&
    typeof persistedActiveModes === "object" &&
    !Array.isArray(persistedActiveModes)
  ) {
    for (const [key, mode] of Object.entries(persistedActiveModes)) {
      if (mode === "base" || mode === "uncommitted") {
        activeModesByScope[key] = mode;
      }
    }
  }
  return { drafts: normalized, activeModesByScope };
}

export function isReviewDraftComment(value: unknown): value is ReviewDraftComment {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.filePath === "string" &&
    (record.side === "old" || record.side === "new") &&
    typeof record.lineNumber === "number" &&
    Number.isInteger(record.lineNumber) &&
    record.lineNumber > 0 &&
    typeof record.body === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
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
