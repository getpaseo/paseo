import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { buildReviewAttachmentSnapshot, buildReviewDraftKey } from "./store";
import {
  addCommentToState,
  clearReviewInState,
  deleteCommentFromState,
  normalizePersistedState,
  type ReviewDraftComment,
  type ReviewDraftStoreState,
  serializeReviewDraftState,
  SerializedReviewDraftStateSchema,
  updateCommentInState,
} from "./state";

function emptyState(): ReviewDraftStoreState {
  return { drafts: {} };
}

function makeComment(overrides: Partial<ReviewDraftComment> = {}): ReviewDraftComment {
  return {
    id: "comment-1",
    filePath: "src/example.ts",
    side: "new",
    lineNumber: 41,
    body: "Please simplify this.",
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
    ...overrides,
  };
}

function makeFile(): ParsedDiffFile {
  return {
    path: "src/example.ts",
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 1,
    status: "ok",
    hunks: [
      {
        oldStart: 40,
        oldCount: 4,
        newStart: 40,
        newCount: 4,
        lines: [
          { type: "header", content: "@@ -40,4 +40,4 @@" },
          { type: "context", content: "const before = true;" },
          { type: "remove", content: "const value = oldValue;" },
          { type: "add", content: "const value = newValue;" },
          { type: "context", content: "return value;" },
        ],
      },
    ],
  };
}

function createMemoryStorage(): StateStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

describe("buildReviewDraftKey", () => {
  it("scopes by server, workspace-or-cwd, diff mode, base ref, and whitespace mode", () => {
    const base = buildReviewDraftKey({
      serverId: " local ",
      workspaceId: " workspace-1 ",
      cwd: "/repo",
      mode: "base",
      baseRef: " main ",
      ignoreWhitespace: false,
    });

    expect(base).toBe(
      "review:server=local:workspace=workspace-1:mode=base:base=main:ignoreWhitespace=false",
    );
    expect(
      buildReviewDraftKey({
        serverId: "local",
        workspaceId: "workspace-1",
        cwd: "/repo",
        mode: "base",
        baseRef: "main",
        ignoreWhitespace: true,
      }),
    ).not.toBe(base);
    expect(
      buildReviewDraftKey({
        serverId: "local",
        workspaceId: null,
        cwd: "/repo/",
        mode: "base",
        baseRef: "main",
        ignoreWhitespace: false,
      }),
    ).toBe("review:server=local:cwd=%2Frepo:mode=base:base=main:ignoreWhitespace=false");
  });
});

describe("normalizePersistedState", () => {
  it("keeps v1 review comments for migration while dropping the legacy mode field", async () => {
    const backing = createMemoryStorage();
    const legacyState = {
      drafts: { "review:key": [makeComment()] },
      activeModesByScope: { "review:scope": "base" },
    };
    backing.values.set(
      "@paseo:review-draft-store",
      JSON.stringify({ state: legacyState, version: 1 }),
    );
    const storage = createValidatedPersistStorage(backing, SerializedReviewDraftStateSchema);

    const stored = await storage.getItem("@paseo:review-draft-store");
    const normalized = normalizePersistedState(stored?.state);

    expect(normalized.drafts["review:key"]).toEqual([makeComment()]);
    expect(backing.values.has("@paseo:review-draft-store")).toBe(true);
  });

  it("rejects the complete payload when any draft comment or field is invalid", () => {
    const normalized = normalizePersistedState({
      drafts: {
        "review:key": [
          {
            id: "comment-1",
            filePath: "src/example.ts",
            side: "new",
            lineNumber: 41,
            body: "Keep me.",
            createdAt: "2026-04-21T00:00:00.000Z",
            updatedAt: "2026-04-21T00:00:00.000Z",
          },
          { id: "bad", filePath: "src/example.ts" },
        ],
      },
      // Old persisted field — must be tolerated and ignored, not migrated.
      activeModesByScope: {
        "review:scope:base": "base",
        "review:scope:dirty": "uncommitted",
      },
    });

    expect(normalized.drafts).toEqual({});
  });

  it("returns empty state for null, non-object, or malformed inputs", () => {
    expect(normalizePersistedState(null)).toEqual({ drafts: {} });
    expect(normalizePersistedState("nope")).toEqual({ drafts: {} });
    expect(normalizePersistedState({ drafts: [] })).toEqual({ drafts: {} });
  });
});

describe("serializeReviewDraftState", () => {
  it("serialized output does not contain the legacy activeModesByScope field", () => {
    const state = addCommentToState(emptyState(), { key: "review:key", comment: makeComment() });

    const serialized = serializeReviewDraftState(state);

    expect(Object.keys(serialized)).toEqual(["drafts"]);
    expect("activeModesByScope" in serialized).toBe(false);
    expect(serialized.drafts["review:key"]).toHaveLength(1);
  });
});

describe("review draft reducers", () => {
  it("adds, updates, and deletes draft comments by key", () => {
    let state = emptyState();
    const comment = makeComment();

    state = addCommentToState(state, { key: "review:key", comment });
    expect(state.drafts["review:key"]).toEqual([comment]);

    state = updateCommentInState(state, {
      key: "review:key",
      id: comment.id,
      updates: { body: "Please simplify this condition." },
      updatedAt: "2026-04-21T00:01:00.000Z",
    });
    expect(state.drafts["review:key"]?.[0]).toEqual({
      ...comment,
      body: "Please simplify this condition.",
      updatedAt: "2026-04-21T00:01:00.000Z",
    });

    state = deleteCommentFromState(state, { key: "review:key", id: comment.id });
    expect(state.drafts["review:key"]).toEqual([]);
  });

  it("keeps state identity on no-op updates, deletes, and clears", () => {
    const state = addCommentToState(emptyState(), {
      key: "review:key",
      comment: makeComment(),
    });

    expect(
      updateCommentInState(state, {
        key: "review:key",
        id: "missing",
        updates: { body: "x" },
        updatedAt: "2026-04-21T00:01:00.000Z",
      }),
    ).toBe(state);
    expect(deleteCommentFromState(state, { key: "review:key", id: "missing" })).toBe(state);
    expect(clearReviewInState(state, { key: "other-key" })).toBe(state);
  });
});

describe("buildReviewAttachmentSnapshot", () => {
  it("builds a bounded workspace review attachment and skips missing targets", () => {
    const snapshot = buildReviewAttachmentSnapshot({
      reviewDraftKey: "review:key",
      cwd: "/repo",
      mode: "base",
      baseRef: "main",
      comments: [
        {
          id: "comment-1",
          filePath: "src/example.ts",
          side: "new",
          lineNumber: 41,
          body: "Please simplify this.",
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
        {
          id: "comment-2",
          filePath: "src/missing.ts",
          side: "new",
          lineNumber: 99,
          body: "This target is stale.",
          createdAt: "2026-04-21T00:00:00.000Z",
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      ],
      diffFiles: [makeFile()],
    });

    expect(snapshot).toEqual({
      kind: "review",
      reviewDraftKey: "review:key",
      commentCount: 1,
      attachment: {
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/repo",
        mode: "base",
        baseRef: "main",
        comments: [
          {
            filePath: "src/example.ts",
            side: "new",
            lineNumber: 41,
            body: "Please simplify this.",
            context: {
              hunkHeader: "@@ -40,4 +40,4 @@",
              targetLine: {
                oldLineNumber: null,
                newLineNumber: 41,
                type: "add",
                content: "const value = newValue;",
              },
              lines: [
                {
                  oldLineNumber: 40,
                  newLineNumber: 40,
                  type: "context",
                  content: "const before = true;",
                },
                {
                  oldLineNumber: 41,
                  newLineNumber: null,
                  type: "remove",
                  content: "const value = oldValue;",
                },
                {
                  oldLineNumber: null,
                  newLineNumber: 41,
                  type: "add",
                  content: "const value = newValue;",
                },
                {
                  oldLineNumber: 42,
                  newLineNumber: 42,
                  type: "context",
                  content: "return value;",
                },
              ],
            },
          },
        ],
      },
    });
  });
});
