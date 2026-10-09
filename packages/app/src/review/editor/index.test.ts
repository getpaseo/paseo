import { describe, expect, it } from "vitest";
import { createReviewEditor, createReviewEditorScope, type ReviewCommentWriter } from "./index";
import type { ReviewDraftComment } from "../state";
import type { ReviewableDiffTarget } from "@/utils/diff-layout";

const target: ReviewableDiffTarget = {
  key: "src/example.ts:new:2",
  filePath: "src/example.ts",
  side: "new",
  lineNumber: 2,
  hunkHeader: "@@ -1,2 +1,2 @@",
  hunkIndex: 0,
  lineIndex: 2,
  oldLineNumber: null,
  newLineNumber: 2,
  lineType: "add",
  content: "const value = next;",
};

function memoryWriter() {
  const drafts = new Map<string, ReviewDraftComment[]>();
  let sequence = 0;
  const writer: ReviewCommentWriter = {
    saveComment: ({ key, id, comment }) => {
      const current = drafts.get(key) ?? [];
      if (id && current.some((saved) => saved.id === id)) {
        drafts.set(
          key,
          current.map((saved) => (saved.id === id ? { ...saved, ...comment } : saved)),
        );
      } else {
        const saved = {
          ...comment,
          id: String(++sequence),
          createdAt: "2026-10-09T00:00:00Z",
          updatedAt: "2026-10-09T00:00:00Z",
        };
        drafts.set(key, [...current, saved]);
      }
    },
    deleteComment: ({ key, id }) => {
      drafts.set(
        key,
        (drafts.get(key) ?? []).filter((comment) => comment.id !== id),
      );
    },
  };
  return { writer, comments: (key: string) => drafts.get(key) ?? [] };
}

describe("review editor", () => {
  it("saves trimmed comments, edits the same record, and cancels without altering saved comments", () => {
    const storage = memoryWriter();
    const editor = createReviewEditor("first", storage.writer);
    editor.start(target);
    editor.setBody("  First comment  ");
    editor.save(editor.getState()!.body);
    expect(editor.getState()).toBeNull();
    const saved = storage.comments("first")[0]!;
    expect(saved).toMatchObject({
      filePath: target.filePath,
      side: "new",
      lineNumber: 2,
      body: "First comment",
    });
    editor.edit(target, saved);
    editor.setBody("Discarded edit");
    editor.cancel();
    expect(storage.comments("first")).toEqual([saved]);
    editor.edit(target, saved);
    editor.save(" Updated comment ");
    expect(storage.comments("first")).toEqual([{ ...saved, body: "Updated comment" }]);
    editor.start(target);
    editor.setBody("Discarded new comment");
    editor.cancel();
    expect(storage.comments("first")).toHaveLength(1);
  });

  it("keeps an open edit saveable after its submitted record is acknowledged", () => {
    const storage = memoryWriter();
    const editor = createReviewEditor("first", storage.writer);
    editor.start(target);
    editor.save("Submitted body");
    const saved = storage.comments("first")[0]!;
    editor.edit(target, saved);
    editor.setBody("Typed before acknowledgement");
    storage.writer.deleteComment({ key: "first", id: saved.id });
    expect(editor.getState()!.body).toBe("Typed before acknowledgement");
    editor.save(editor.getState()!.body);
    expect(storage.comments("first")).toMatchObject([
      {
        body: "Typed before acknowledgement",
        filePath: target.filePath,
        lineNumber: target.lineNumber,
      },
    ]);
  });

  it("rejects empty saves and repeated saves after the editor closes", () => {
    const storage = memoryWriter();
    const editor = createReviewEditor("first", storage.writer);
    editor.start(target);
    editor.save(" \n ");
    expect(editor.getState()).toEqual({ target, commentId: null, body: "" });
    expect(storage.comments("first")).toEqual([]);
    editor.save("Saved once");
    editor.save("Duplicate");
    expect(storage.comments("first").map((comment) => comment.body)).toEqual(["Saved once"]);
  });

  it("isolates draft ownership and closes an editor when its saved comment is deleted", () => {
    const storage = memoryWriter();
    const first = createReviewEditor("first", storage.writer);
    const second = createReviewEditor("second", storage.writer);
    first.start(target);
    first.save("First workspace");
    const saved = storage.comments("first")[0]!;
    first.edit(target, saved);
    expect(second.getState()).toBeNull();
    second.start(target);
    second.save("Second workspace");
    first.delete(saved.id);
    expect(first.getState()).toBeNull();
    expect(storage.comments("first")).toEqual([]);
    expect(storage.comments("second").map((comment) => comment.body)).toEqual(["Second workspace"]);
  });
});

it("retains an open editor through remounts without exposing it on another surface or draft", async () => {
  const storage = memoryWriter();
  const scope = createReviewEditorScope(storage.writer);
  const editor = scope.forDraft("first", "diff");
  const unsubscribe = editor.subscribe(() => {});
  editor.start(target);
  editor.setBody("Unsaved wide body");
  unsubscribe();
  await Promise.resolve();
  const compact = scope.forDraft("first", "diff");
  expect(compact.getState()!.body).toBe("Unsaved wide body");
  expect(scope.forDraft("first", "combined").getState()).toBeNull();
  expect(scope.forDraft("second", "diff").getState()).toBeNull();
  compact.save(compact.getState()!.body);
  expect(storage.comments("first")[0]!.body).toBe("Unsaved wide body");
  expect(scope.forDraft("first", "diff").getState()).toBeNull();
});
