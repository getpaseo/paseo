import type { StreamItem, UserMessageItem } from "@/types/stream";

export interface PendingMessageSubmission {
  clientMessageId: string;
  submittedAt: Date;
}

export type MessageSubmissionAcceptance = "rpc-only" | "rpc-and-running";

export type MessageSubmissionRecord = PendingMessageSubmission &
  (
    | { phase: "waiting-for-rpc"; acceptance: MessageSubmissionAcceptance }
    | { phase: "waiting-for-running" }
    | { phase: "running-observed" }
  );

export function getPendingMessageSubmission(
  submission: MessageSubmissionRecord | null | undefined,
): PendingMessageSubmission | null {
  return submission && submission.phase !== "running-observed" ? submission : null;
}

export interface MessageSubmissionState {
  tail: StreamItem[];
  head: StreamItem[];
  submission: MessageSubmissionRecord | null;
}

export type MessageSubmissionRejectionOutcome = "rejected" | "accepted" | "unknown";

export interface MessageSubmissionRejectionResult {
  state: MessageSubmissionState;
  outcome: MessageSubmissionRejectionOutcome;
}

export function beginMessageSubmission(
  state: MessageSubmissionState,
  input: {
    message: UserMessageItem;
    submittedAt: Date;
    acceptance: MessageSubmissionAcceptance;
  },
): MessageSubmissionState {
  if (!input.message.clientMessageId) {
    throw new Error("Submitted user message requires client identity");
  }
  const pending = {
    clientMessageId: input.message.clientMessageId,
    submittedAt: input.submittedAt,
    phase: "waiting-for-rpc" as const,
    acceptance: input.acceptance,
  };
  // A submission carries a freshly generated client identity, so it cannot already be in
  // the timeline. Append it. Reconciling here would let the legacy content fallback adopt
  // an older row that happens to repeat the same text.
  if (state.head.length > 0) {
    return {
      tail: state.tail,
      head: [...state.head, input.message],
      submission: pending,
    };
  }
  return {
    tail: [...state.tail, input.message],
    head: state.head,
    submission: pending,
  };
}

export function acceptMessageSubmission(
  state: MessageSubmissionState,
  clientMessageId: string,
): MessageSubmissionState {
  if (state.submission?.clientMessageId !== clientMessageId) {
    return state;
  }
  if (state.submission.phase === "running-observed") {
    return { ...state, submission: null };
  }
  if (state.submission.phase === "waiting-for-running") return state;
  return state.submission.acceptance === "rpc-only"
    ? { ...state, submission: null }
    : {
        ...state,
        submission: {
          clientMessageId: state.submission.clientMessageId,
          submittedAt: state.submission.submittedAt,
          phase: "waiting-for-running",
        },
      };
}

export function observeMessageSubmissionRunning(
  submission: MessageSubmissionRecord | null,
): MessageSubmissionRecord | null {
  if (!submission || submission.phase === "running-observed") return submission;
  if (submission.phase === "waiting-for-running") return null;
  if (submission.acceptance === "rpc-only") return submission;
  return {
    clientMessageId: submission.clientMessageId,
    submittedAt: submission.submittedAt,
    phase: "running-observed",
  };
}

function removeSubmittedMessage(items: StreamItem[], clientMessageId: string): StreamItem[] {
  const next = items.filter(
    (item) => item.kind !== "user_message" || item.clientMessageId !== clientMessageId,
  );
  return next.length === items.length ? items : next;
}

export function rejectMessageSubmission(
  state: MessageSubmissionState,
  clientMessageId: string,
): MessageSubmissionRejectionResult {
  if (state.submission?.clientMessageId !== clientMessageId) {
    return { outcome: "unknown", state };
  }
  if (
    state.submission.phase === "running-observed" ||
    state.submission.phase === "waiting-for-running"
  ) {
    return { outcome: "accepted", state: { ...state, submission: null } };
  }
  return {
    outcome: "rejected",
    state: {
      tail: removeSubmittedMessage(state.tail, clientMessageId),
      head: removeSubmittedMessage(state.head, clientMessageId),
      submission: null,
    },
  };
}
