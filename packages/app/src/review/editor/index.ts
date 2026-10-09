import type { ReviewableDiffTarget } from "@/utils/diff-layout";
import type { InlineReviewEditorState } from "../geometry";
import type { ReviewDraftComment } from "../state";

export interface ReviewCommentWriter {
  addComment: (input: {
    key: string;
    comment: Pick<ReviewDraftComment, "filePath" | "side" | "lineNumber" | "body">;
  }) => unknown;
  updateComment: (input: { key: string; id: string; updates: { body: string } }) => void;
  deleteComment: (input: { key: string; id: string }) => void;
}

/** One editor belongs to one review draft; replacing the draft creates a fresh editor. */
export function createReviewEditor(key: string, writer: ReviewCommentWriter) {
  let editor: InlineReviewEditorState | null = null;
  const listeners = new Set<() => void>();
  function publish(next: InlineReviewEditorState | null) {
    editor = next;
    listeners.forEach((listener) => listener());
  }
  return {
    getState: () => editor,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
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
      if (editor.commentId) {
        writer.updateComment({ key, id: editor.commentId, updates: { body: trimmedBody } });
      } else {
        writer.addComment({
          key,
          comment: {
            filePath: editor.target.filePath,
            side: editor.target.side,
            lineNumber: editor.target.lineNumber,
            body: trimmedBody,
          },
        });
      }
      publish(null);
    },
    delete: (id: string) => {
      writer.deleteComment({ key, id });
      if (editor?.commentId === id) publish(null);
    },
  };
}
