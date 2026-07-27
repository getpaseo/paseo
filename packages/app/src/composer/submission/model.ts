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
  );

export function getPendingMessageSubmission(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
): PendingMessageSubmission | null {
  return submissions?.at(-1) ?? null;
}

export interface MessageSubmissionState {
  tail: StreamItem[];
  head: StreamItem[];
  submissions: MessageSubmissionRecord[];
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
  const pending: MessageSubmissionRecord = {
    clientMessageId: input.message.clientMessageId,
    submittedAt: input.submittedAt,
    phase: "waiting-for-rpc",
    acceptance: input.acceptance,
  };
  // A submission carries a freshly generated client identity, so it cannot already be in
  // the timeline. Append it. Reconciling here would let the legacy content fallback adopt
  // an older row that happens to repeat the same text.
  return state.head.length > 0
    ? {
        tail: state.tail,
        head: [...state.head, input.message],
        submissions: [...state.submissions, pending],
      }
    : {
        tail: [...state.tail, input.message],
        head: state.head,
        submissions: [...state.submissions, pending],
      };
}

export function acceptMessageSubmission(
  state: MessageSubmissionState,
  clientMessageId: string,
  isAgentRunning = false,
): MessageSubmissionState {
  const index = state.submissions.findIndex(
    (submission) => submission.clientMessageId === clientMessageId,
  );
  if (index === -1) return state;
  const submission = state.submissions[index];
  if (submission.phase === "waiting-for-running") return state;
  const nextSubmission: MessageSubmissionRecord | null =
    submission.acceptance === "rpc-only" || isAgentRunning
      ? null
      : {
          clientMessageId: submission.clientMessageId,
          submittedAt: submission.submittedAt,
          phase: "waiting-for-running",
        };
  const submissions = state.submissions.slice();
  if (nextSubmission) submissions[index] = nextSubmission;
  else submissions.splice(index, 1);
  return { ...state, submissions };
}

export function observeMessageSubmissionRunning(
  submissions: readonly MessageSubmissionRecord[],
): MessageSubmissionRecord[] {
  const next = submissions.filter((submission) => submission.phase !== "waiting-for-running");
  return next.length === submissions.length ? (submissions as MessageSubmissionRecord[]) : next;
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
  const index = state.submissions.findIndex(
    (submission) => submission.clientMessageId === clientMessageId,
  );
  if (index === -1) return { outcome: "unknown", state };
  const submission = state.submissions[index];
  const submissions = state.submissions.slice();
  submissions.splice(index, 1);
  if (submission.phase === "waiting-for-running") {
    return { outcome: "accepted", state: { ...state, submissions } };
  }
  return {
    outcome: "rejected",
    state: {
      tail: removeSubmittedMessage(state.tail, clientMessageId),
      head: removeSubmittedMessage(state.head, clientMessageId),
      submissions,
    },
  };
}
