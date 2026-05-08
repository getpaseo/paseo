import { useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ComposerAttachment } from "@/attachments/types";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { generateMessageId } from "@/types/stream";
import { buildNumberedDiffHunks, type NumberedDiffLine } from "@/utils/diff-layout";
import type { AgentAttachment } from "@server/shared/messages";

const STORE_VERSION = 1;
const CONTEXT_RADIUS = 3;
const EMPTY_REVIEW_DRAFT_COMMENTS: ReviewDraftComment[] = [];

type ReviewAttachment = Extract<AgentAttachment, { type: "review" }>;
type ReviewAttachmentContextLine = ReviewAttachment["comments"][number]["context"]["targetLine"];
type ReviewComposerAttachment = Extract<ComposerAttachment, { kind: "review" }>;

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

export interface BuildReviewDraftKeyInput {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  mode: ReviewDraftMode;
  baseRef?: string | null;
  ignoreWhitespace: boolean;
}

export type BuildReviewDraftScopeKeyInput = Omit<BuildReviewDraftKeyInput, "mode">;

export interface BuildReviewAttachmentSnapshotInput {
  reviewDraftKey: string;
  cwd: string;
  mode: ReviewDraftMode;
  baseRef?: string | null;
  comments: readonly ReviewDraftComment[];
  diffFiles: readonly ParsedDiffFile[];
}

interface ReviewDraftStoreState {
  drafts: Record<string, ReviewDraftComment[]>;
  activeModesByScope: Record<string, ReviewDraftMode>;
}

interface ReviewDraftStoreActions {
  setActiveMode: (input: { scopeKey: string; mode: ReviewDraftMode }) => void;
  addComment: (input: { key: string; comment: ReviewDraftCommentInput }) => ReviewDraftComment;
  updateComment: (input: {
    key: string;
    id: string;
    updates: Partial<Pick<ReviewDraftComment, "body">>;
    updatedAt?: string;
  }) => void;
  deleteComment: (input: { key: string; id: string }) => void;
  clearReview: (input: { key: string }) => void;
}

export type ReviewDraftCommentInput = Omit<ReviewDraftComment, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<ReviewDraftComment, "id" | "createdAt" | "updatedAt">>;

type ReviewDraftStore = ReviewDraftStoreState & ReviewDraftStoreActions;

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeBaseRef(baseRef: string | null | undefined): string {
  return baseRef?.trim() ?? "";
}

function buildReviewDraftScopeParts(input: BuildReviewDraftScopeKeyInput): string[] {
  const workspaceId = input.workspaceId?.trim();
  const workspacePart = workspaceId
    ? `workspace=${encodeKeyPart(workspaceId)}`
    : `cwd=${encodeKeyPart(normalizeCwd(input.cwd))}`;

  return [
    "review",
    `server=${encodeKeyPart(input.serverId)}`,
    workspacePart,
    `base=${encodeKeyPart(normalizeBaseRef(input.baseRef))}`,
    `ignoreWhitespace=${input.ignoreWhitespace ? "true" : "false"}`,
  ];
}

export function buildReviewDraftScopeKey(input: BuildReviewDraftScopeKeyInput): string {
  return buildReviewDraftScopeParts(input).join(":");
}

export function buildReviewDraftKey(input: BuildReviewDraftKeyInput): string {
  const [prefix, serverPart, workspacePart, basePart, whitespacePart] =
    buildReviewDraftScopeParts(input);
  return [prefix, serverPart, workspacePart, `mode=${input.mode}`, basePart, whitespacePart].join(
    ":",
  );
}

function createDraftComment(input: ReviewDraftCommentInput): ReviewDraftComment {
  const now = new Date().toISOString();
  return {
    id: input.id ?? generateMessageId(),
    filePath: input.filePath,
    side: input.side,
    lineNumber: input.lineNumber,
    body: input.body,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now,
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

function normalizePersistedState(state: unknown): ReviewDraftStoreState {
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

function isReviewDraftComment(value: unknown): value is ReviewDraftComment {
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

export const useReviewDraftStore = create<ReviewDraftStore>()(
  persist(
    (set) => ({
      drafts: {},
      activeModesByScope: {},
      setActiveMode: ({ scopeKey, mode }) => {
        set((state) => {
          if (state.activeModesByScope[scopeKey] === mode) {
            return state;
          }
          return {
            activeModesByScope: {
              ...state.activeModesByScope,
              [scopeKey]: mode,
            },
          };
        });
      },
      addComment: ({ key, comment }) => {
        const nextComment = createDraftComment(comment);
        set((state) => ({
          drafts: {
            ...state.drafts,
            [key]: [...(state.drafts[key] ?? []), nextComment],
          },
        }));
        return nextComment;
      },
      updateComment: ({ key, id, updates, updatedAt }) => {
        set((state) => {
          const comments = state.drafts[key] ?? [];
          if (!comments.some((comment) => comment.id === id)) {
            return state;
          }
          const nextUpdatedAt = updatedAt ?? new Date().toISOString();
          return {
            drafts: {
              ...state.drafts,
              [key]: comments.map((comment) =>
                applyCommentUpdates(comment, id, updates, nextUpdatedAt),
              ),
            },
          };
        });
      },
      deleteComment: ({ key, id }) => {
        set((state) => {
          const comments = state.drafts[key] ?? [];
          if (!comments.some((comment) => comment.id === id)) {
            return state;
          }
          return {
            drafts: {
              ...state.drafts,
              [key]: comments.filter((comment) => comment.id !== id),
            },
          };
        });
      },
      clearReview: ({ key }) => {
        set((state) => {
          if (!state.drafts[key]) {
            return state;
          }
          const next = { ...state.drafts };
          delete next[key];
          return { drafts: next };
        });
      },
    }),
    {
      name: "@paseo:review-draft-store",
      version: STORE_VERSION,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        drafts: state.drafts,
        activeModesByScope: state.activeModesByScope,
      }),
      migrate: async (state) => normalizePersistedState(state),
    },
  ),
);

function toContextLine(line: NumberedDiffLine): ReviewAttachmentContextLine | null {
  if (line.line.type === "header") {
    return null;
  }
  return {
    oldLineNumber: line.oldLineNumber,
    newLineNumber: line.newLineNumber,
    type: line.line.type,
    content: line.line.content,
  };
}

function findTarget(input: { comment: ReviewDraftComment; diffFiles: readonly ParsedDiffFile[] }): {
  hunkHeader: string;
  hunkLines: NumberedDiffLine[];
  targetIndex: number;
  targetLine: NumberedDiffLine;
} | null {
  const file = input.diffFiles.find((candidate) => candidate.path === input.comment.filePath);
  if (!file) {
    return null;
  }

  for (const hunk of buildNumberedDiffHunks(file)) {
    const targetIndex = hunk.lines.findIndex((line) => {
      const cell = input.comment.side === "old" ? line.oldCell : line.newCell;
      return cell?.lineNumber === input.comment.lineNumber;
    });
    const targetLine = hunk.lines[targetIndex];
    if (targetLine) {
      return {
        hunkHeader: hunk.hunkHeader,
        hunkLines: hunk.lines,
        targetIndex,
        targetLine,
      };
    }
  }

  return null;
}

export function buildReviewAttachmentSnapshot(
  input: BuildReviewAttachmentSnapshotInput,
): ReviewComposerAttachment | null {
  const comments: ReviewAttachment["comments"] = [];

  for (const draftComment of input.comments) {
    const target = findTarget({
      comment: draftComment,
      diffFiles: input.diffFiles,
    });
    if (!target) {
      continue;
    }

    const targetLine = toContextLine(target.targetLine);
    if (!targetLine) {
      continue;
    }

    const contextStart = Math.max(0, target.targetIndex - CONTEXT_RADIUS);
    const contextEnd = Math.min(target.hunkLines.length, target.targetIndex + CONTEXT_RADIUS + 1);
    const lines = target.hunkLines
      .slice(contextStart, contextEnd)
      .map(toContextLine)
      .filter((line): line is ReviewAttachmentContextLine => line !== null);

    comments.push({
      filePath: draftComment.filePath,
      side: draftComment.side,
      lineNumber: draftComment.lineNumber,
      body: draftComment.body,
      context: {
        hunkHeader: target.hunkHeader,
        targetLine,
        lines,
      },
    });
  }

  if (comments.length === 0) {
    return null;
  }

  const attachment: ReviewAttachment = {
    type: "review",
    mimeType: "application/paseo-review",
    cwd: input.cwd,
    mode: input.mode,
    baseRef: normalizeBaseRef(input.baseRef) || null,
    comments,
  };

  return {
    kind: "review",
    reviewDraftKey: input.reviewDraftKey,
    commentCount: comments.length,
    attachment,
  };
}

export function useReviewDraftComments(key: string): ReviewDraftComment[] {
  return useReviewDraftStore((state) => state.drafts[key] ?? EMPTY_REVIEW_DRAFT_COMMENTS);
}

export function useSetActiveReviewDraftMode(): ReviewDraftStoreActions["setActiveMode"] {
  return useReviewDraftStore((state) => state.setActiveMode);
}

export function useClearReviewDraft(): ReviewDraftStoreActions["clearReview"] {
  return useReviewDraftStore((state) => state.clearReview);
}

export function addReviewDraftComment(input: {
  key: string;
  comment: ReviewDraftCommentInput;
}): ReviewDraftComment {
  return useReviewDraftStore.getState().addComment(input);
}

export function getReviewDraftComments(key: string): ReviewDraftComment[] | undefined {
  return useReviewDraftStore.getState().drafts[key];
}

export function resetReviewDraftStore(): void {
  useReviewDraftStore.setState({ drafts: {}, activeModesByScope: {} });
}

export function useReviewDraftCommentsForAttachment(input: {
  key: string;
  enabled: boolean;
}): ReviewDraftComment[] {
  return useReviewDraftStore((state) =>
    input.enabled
      ? (state.drafts[input.key] ?? EMPTY_REVIEW_DRAFT_COMMENTS)
      : EMPTY_REVIEW_DRAFT_COMMENTS,
  );
}

export function useReviewCommentCount(key: string): number {
  return useReviewDraftStore((state) => state.drafts[key]?.length ?? 0);
}

export function useActiveReviewDraftMode(input: { scopeKey: string }): ReviewDraftMode | null {
  return useReviewDraftStore((state) => state.activeModesByScope[input.scopeKey] ?? null);
}

export function useReviewAttachmentSnapshot(input: {
  key: string;
  diffFiles: readonly ParsedDiffFile[];
  cwd: string;
  mode: ReviewDraftMode;
  baseRef?: string | null;
}): ReviewComposerAttachment | null {
  const comments = useReviewDraftComments(input.key);
  return useMemo(
    () =>
      buildReviewAttachmentSnapshot({
        reviewDraftKey: input.key,
        cwd: input.cwd,
        mode: input.mode,
        baseRef: input.baseRef,
        comments,
        diffFiles: input.diffFiles,
      }),
    [comments, input.key, input.cwd, input.mode, input.baseRef, input.diffFiles],
  );
}
