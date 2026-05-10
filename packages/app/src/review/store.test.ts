import "@/test/window-local-storage";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@/git/use-diff-query";
import {
  buildReviewAttachmentSnapshot,
  buildReviewDraftKey,
  buildReviewDraftScopeKey,
  useReviewDraftStore,
} from "./store";

const STORE_STORAGE_KEY = "@paseo:review-draft-store";

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

  it("builds a mode-free scope key for active review mode sharing", () => {
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

describe("review draft store", () => {
  it("normalizes persisted active review modes with draft comments", async () => {
    await AsyncStorage.setItem(
      STORE_STORAGE_KEY,
      JSON.stringify({
        version: 0,
        state: {
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
          activeModesByScope: {
            "review:scope:base": "base",
            "review:scope:dirty": "uncommitted",
            "review:scope:bad": "other",
          },
        },
      }),
    );

    await useReviewDraftStore.persist.rehydrate();

    const state = useReviewDraftStore.getState();
    expect(state.activeModesByScope).toEqual({
      "review:scope:base": "base",
      "review:scope:dirty": "uncommitted",
    });
    expect(state.drafts["review:key"]).toEqual([
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

  it("persists compact draft comments separately from workspace attachment wire context", () => {
    const key = buildReviewDraftKey({
      serverId: "local",
      workspaceId: "workspace-1",
      cwd: "/repo",
      mode: "uncommitted",
      baseRef: null,
      ignoreWhitespace: false,
    });

    useReviewDraftStore.getState().clearReview({ key });
    useReviewDraftStore.getState().addComment({
      key,
      comment: {
        id: "comment-1",
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 41,
        body: "Please simplify this.",
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    });

    expect(useReviewDraftStore.getState().drafts[key]).toEqual([
      {
        id: "comment-1",
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 41,
        body: "Please simplify this.",
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    ]);

    useReviewDraftStore.getState().updateComment({
      key,
      id: "comment-1",
      updates: { body: "Please simplify this condition." },
      updatedAt: "2026-04-21T00:01:00.000Z",
    });
    expect(useReviewDraftStore.getState().drafts[key]?.[0]?.body).toBe(
      "Please simplify this condition.",
    );

    useReviewDraftStore.getState().deleteComment({ key, id: "comment-1" });
    expect(useReviewDraftStore.getState().drafts[key]).toEqual([]);
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
