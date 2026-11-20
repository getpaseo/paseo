import type { ReviewableDiffTarget } from "@/utils/diff-layout";
import type { InlineReviewEditorState } from "../geometry";
import type { ReviewDraftComment } from "../state";

export interface ReviewCommentWriter {
  saveComment: (input: {
    key: string;
    id: string | null;
    comment: Pick<ReviewDraftComment, "filePath" | "side" | "lineNumber" | "body">;
  }) => void;
  deleteComment: (input: { key: string; id: string }) => void;
}

/** One editor belongs to one review draft; replacing the draft creates a fresh editor. */
export function createReviewEditor(key: string, writer: ReviewCommentWriter) {
  return buildReviewEditor(key, writer, () => {});
}

function buildReviewEditor(key: string, writer: ReviewCommentWriter, onUnused: () => void) {
  let editor: InlineReviewEditorState | null = null;
  const listeners = new Set<() => void>();
  function publish(next: InlineReviewEditorState | null) {
    editor = next;
    listeners.forEach((listener) => listener());
    if (!editor && listeners.size === 0) onUnused();
  }
  return {
    getState: () => editor,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        queueMicrotask(() => {
          if (!editor && listeners.size === 0) onUnused();
        });
      };
    },
    start: (target: ReviewableDiffTarget) => publish({ target, commentId: null, body: "" }),
    edit: (target: ReviewableDiffTarget, comment: ReviewDraftComment) =>
      publish({ target, commentId: comment.id, body: comment.body }),
    setBody: (body: string) => {
      if (editor) publish({ ...editor, body });
    },
    cancel: () => publish(null),
    save: (body: string) => {
      const trimmedBody = body.trim();
      if (!editor || !trimmedBody) return;
      writer.saveComment({
        key,
        id: editor.commentId,
        comment: {
          filePath: editor.target.filePath,
          side: editor.target.side,
          lineNumber: editor.target.lineNumber,
          body: trimmedBody,
        },
      });
      publish(null);
    },
    delete: (id: string) => {
      writer.deleteComment({ key, id });
      if (editor?.commentId === id) publish(null);
    },
  };
}

/** An open draft survives presentation remounts; each presentation owns its editor for that draft. */
export function createReviewEditorScope(writer: ReviewCommentWriter) {
  const editors = new Map<string, ReturnType<typeof createReviewEditor>>();
  return {
    forDraft(key: string, presentation: string) {
      const owner = JSON.stringify([key, presentation]);
      let model = editors.get(owner);
      if (!model) {
        const created = buildReviewEditor(key, writer, () => {
          if (editors.get(owner) === created) editors.delete(owner);
        });
        model = created;
        editors.set(owner, model);
      }
      return model;
    },
  };
}
