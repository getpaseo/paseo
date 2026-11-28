import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

export interface PlanComment {
  id: number;
  start: number;
  end: number;
  text: string;
}

type ReviewError = "invalidRange" | "enterComment" | "enterFeedback";

interface ReviewState {
  comments: PlanComment[];
  nextId: number;
  start: string;
  end: string;
  text: string;
  feedback: string;
  commentTarget: "plan" | "lines";
  error: ReviewError | null;
  hasFeedback: boolean;
}

export function openPlanReview(plan: string) {
  const lines = plan.split(/\r?\n/);
  const listeners = new Set<() => void>();
  let state: ReviewState = {
    comments: [],
    nextId: 0,
    start: "1",
    end: "1",
    text: "",
    feedback: "",
    commentTarget: "plan",
    error: null,
    hasFeedback: false,
  };

  function publish(patch: Partial<typeof state>) {
    state = { ...state, ...patch };
    state.hasFeedback =
      state.comments.length > 0 || Boolean(state.text.trim()) || Boolean(state.feedback.trim());
    for (const listener of listeners) listener();
  }

  function readRange() {
    const start = Number(state.start);
    const end = Number(state.end);
    const wholeNumbers = /^\d+$/.test(state.start) && /^\d+$/.test(state.end);
    const inBounds = start >= 1 && end >= start && end <= lines.length;
    if (!wholeNumbers || !inBounds) {
      publish({ error: "invalidRange" });
      return null;
    }
    return { start, end };
  }

  return {
    lines,
    hasPlan: plan.trim().length > 0,
    numberedPlan: lines.map((line, index) => `${index + 1}  ${line}`).join("\n"),
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      listeners.clear();
    },
    selectLines(anchor: number, focus: number = anchor) {
      const validLine = (line: number) =>
        Number.isInteger(line) && line >= 1 && line <= lines.length;
      if (!validLine(anchor) || !validLine(focus)) {
        publish({ error: "invalidRange" });
        return false;
      }
      publish({
        start: String(Math.min(anchor, focus)),
        end: String(Math.max(anchor, focus)),
        commentTarget: "lines",
        error: null,
      });
      return true;
    },
    setCommentTarget(commentTarget: "plan" | "lines") {
      publish({ commentTarget, error: null });
    },
    setField(field: "start" | "end" | "text" | "feedback", value: string) {
      publish({ [field]: value, error: null });
    },
    editComment(id: number, text: string) {
      const comments = state.comments.map((comment) =>
        comment.id === id ? { ...comment, text } : comment,
      );
      publish({ comments, error: null });
    },
    removeComment(id: number) {
      publish({ comments: state.comments.filter((comment) => comment.id !== id), error: null });
    },
    addComment() {
      if (!state.text.trim()) {
        publish({ error: "enterComment" });
        return;
      }
      const range = readRange();
      if (!range) return;
      const comment = { id: state.nextId, ...range, text: state.text.trim() };
      publish({
        comments: [...state.comments, comment],
        nextId: state.nextId + 1,
        text: "",
        error: null,
      });
    },
    requestChanges(): AgentPermissionResponse | null {
      let comments = state.comments;
      if (state.text.trim()) {
        const range = readRange();
        if (!range) return null;
        comments = [...comments, { id: state.nextId, ...range, text: state.text.trim() }];
      }
      if (comments.some((comment) => !comment.text.trim())) {
        publish({ error: "enterComment" });
        return null;
      }
      const parts = comments.map((comment) => {
        const quote = lines
          .slice(comment.start - 1, comment.end)
          .map((line) => `> ${line}`)
          .join("\n");
        return `Proposed plan lines ${comment.start}-${comment.end}:\n${quote}\n\nComment:\n${comment.text.trim()}`;
      });
      if (state.feedback.trim()) parts.push(state.feedback.trim());
      if (!parts.length) {
        publish({ error: "enterFeedback" });
        return null;
      }
      publish({ error: null });
      return { behavior: "deny", selectedActionId: "request_changes", message: parts.join("\n\n") };
    },
  };
}
