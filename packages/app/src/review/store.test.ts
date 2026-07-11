import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import {
  buildReviewAttachmentSnapshot,
  buildReviewDraftKey,
  buildReviewDraftScopeKey,
} from "./store";
import {
  addCommentToState,
  clearReviewInState,
  deleteCommentFromState,
  type DiffModeOverride,
  expireStaleDiffModeOverridesInState,
  normalizePersistedState,
  resolveDiffMode,
  type ReviewDraftComment,
  type ReviewDraftStoreState,
  serializeReviewDraftState,
  setDiffModeOverrideInState,
  updateCommentInState,
} from "./state";

function emptyState(): ReviewDraftStoreState {
  return { drafts: {}, diffModeOverrides: {} };
}

function makeOverride(
  input: Pick<DiffModeOverride, "mode" | "isDirtyAtSelection">,
): DiffModeOverride {
  return { serverId: "server-1", cwd: "/repo", ...input };
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

  it("builds a mode-free scope key for diff mode override sharing", () => {
    const scope = buildReviewDraftScopeKey({
      serverId: "local",
      workspaceId: "workspace-1",
      cwd: "/repo",
      baseRef: "main",
      ignoreWhitespace: false,
    });

    expect(scope).toBe(
      "review:server=local:workspace=workspace-1:base=main:ignoreWhitespace=false",
    );
    expect(scope).not.toContain("mode=");
  });
});

describe("normalizePersistedState", () => {
  it("filters invalid draft comments and ignores activeModesByScope from old persisted JSON", () => {
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

    expect(normalized.diffModeOverrides).toEqual({});
    expect(normalized.drafts["review:key"]).toEqual([
      {
        id: "comment-1",
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 41,
        body: "Keep me.",
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    ]);
  });

  it("returns empty state for null, non-object, or malformed inputs", () => {
    expect(normalizePersistedState(null)).toEqual({ drafts: {}, diffModeOverrides: {} });
    expect(normalizePersistedState("nope")).toEqual({ drafts: {}, diffModeOverrides: {} });
    expect(normalizePersistedState({ drafts: [] })).toEqual({
      drafts: {},
      diffModeOverrides: {},
    });
  });
});

describe("serializeReviewDraftState", () => {
  it("serialized output does not contain activeModesByScope or diffModeOverrides", () => {
    const state = setDiffModeOverrideInState(
      addCommentToState(emptyState(), { key: "review:key", comment: makeComment() }),
      {
        scopeKey: "review:scope",
        override: makeOverride({ mode: "uncommitted", isDirtyAtSelection: true }),
      },
    );

    const serialized = serializeReviewDraftState(state);

    expect(Object.keys(serialized)).toEqual(["drafts"]);
    expect("activeModesByScope" in serialized).toBe(false);
    expect("diffModeOverrides" in serialized).toBe(false);
    expect(serialized.drafts["review:key"]).toHaveLength(1);
  });
});

describe("diff mode override", () => {
  it("resolves to auto mode from the dirty state when no override exists", () => {
    expect(resolveDiffMode({ override: undefined, hasUncommittedChanges: true })).toBe(
      "uncommitted",
    );
    expect(resolveDiffMode({ override: undefined, hasUncommittedChanges: false })).toBe("base");
  });

  it("honors the override while isDirty matches the value at selection, across remounts", () => {
    const state = setDiffModeOverrideInState(emptyState(), {
      scopeKey: "review:scope",
      override: makeOverride({ mode: "base", isDirtyAtSelection: true }),
    });

    // Resolution is a plain store read, so it gives the same answer on every (re)mount.
    const override = state.diffModeOverrides["review:scope"];
    expect(resolveDiffMode({ override, hasUncommittedChanges: true })).toBe("base");
  });

  it("masks a stale override before its expiry lands", () => {
    const state = setDiffModeOverrideInState(emptyState(), {
      scopeKey: "review:scope",
      override: makeOverride({ mode: "uncommitted", isDirtyAtSelection: true }),
    });

    const override = state.diffModeOverrides["review:scope"];
    expect(resolveDiffMode({ override, hasUncommittedChanges: false })).toBe("base");
  });

  it("expires overrides for the checkout whose dirty state flipped, keeping the rest", () => {
    let state = setDiffModeOverrideInState(emptyState(), {
      scopeKey: "review:scope-a",
      override: makeOverride({ mode: "base", isDirtyAtSelection: true }),
    });
    state = setDiffModeOverrideInState(state, {
      scopeKey: "review:scope-b",
      override: makeOverride({ mode: "uncommitted", isDirtyAtSelection: false }),
    });
    state = setDiffModeOverrideInState(state, {
      scopeKey: "review:scope-other",
      override: {
        serverId: "server-2",
        cwd: "/other",
        mode: "base",
        isDirtyAtSelection: true,
      },
    });

    const next = expireStaleDiffModeOverridesInState(state, {
      serverId: "server-1",
      cwd: "/repo",
      isDirty: false,
    });

    expect(next.diffModeOverrides["review:scope-a"]).toBeUndefined();
    expect(next.diffModeOverrides["review:scope-b"]).toBeDefined();
    expect(next.diffModeOverrides["review:scope-other"]).toBeDefined();
  });

  it("does not resurrect an expired override when the dirty state flips back", () => {
    let state = setDiffModeOverrideInState(emptyState(), {
      scopeKey: "review:scope",
      override: makeOverride({ mode: "base", isDirtyAtSelection: true }),
    });

    // The checkout goes clean (e.g. agent commits): the override expires at the boundary.
    state = expireStaleDiffModeOverridesInState(state, {
      serverId: "server-1",
      cwd: "/repo",
      isDirty: false,
    });
    // The checkout goes dirty again: nothing to expire, and nothing comes back.
    state = expireStaleDiffModeOverridesInState(state, {
      serverId: "server-1",
      cwd: "/repo",
      isDirty: true,
    });

    expect(state.diffModeOverrides["review:scope"]).toBeUndefined();
    expect(
      resolveDiffMode({
        override: state.diffModeOverrides["review:scope"],
        hasUncommittedChanges: true,
      }),
    ).toBe("uncommitted");
  });

  it("keeps state identity when no override is stale", () => {
    const state = setDiffModeOverrideInState(emptyState(), {
      scopeKey: "review:scope",
      override: makeOverride({ mode: "base", isDirtyAtSelection: true }),
    });

    expect(
      expireStaleDiffModeOverridesInState(state, {
        serverId: "server-1",
        cwd: "/repo",
        isDirty: true,
      }),
    ).toBe(state);
    expect(
      expireStaleDiffModeOverridesInState(emptyState(), {
        serverId: "server-1",
        cwd: "/repo",
        isDirty: false,
      }),
    ).toEqual(emptyState());
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
