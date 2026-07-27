export interface PendingMessageSubmission {
  clientMessageId: string;
  submittedAt: Date;
}

export type MessageSubmissionRecord = PendingMessageSubmission & {
  rpcAccepted: boolean;
  providerAcknowledged: boolean;
};

const EMPTY_MESSAGE_SUBMISSIONS: readonly MessageSubmissionRecord[] = [];

export function getActiveMessageSubmissions(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
): readonly PendingMessageSubmission[] {
  return submissions ?? EMPTY_MESSAGE_SUBMISSIONS;
}

export function getSendingClientMessageIds(
  submissions: readonly MessageSubmissionRecord[] | null | undefined,
): string[] {
  return (submissions ?? [])
    .filter((submission) => !submission.providerAcknowledged)
    .map((submission) => submission.clientMessageId);
}

export type MessageSubmissionRejectionOutcome = "rejected" | "accepted" | "unknown";

export interface MessageSubmissionRejectionResult {
  submissions: MessageSubmissionRecord[];
  outcome: MessageSubmissionRejectionOutcome;
}

export function beginMessageSubmission(
  submissions: readonly MessageSubmissionRecord[],
  input: PendingMessageSubmission,
): MessageSubmissionRecord[] {
  if (submissions.some((submission) => submission.clientMessageId === input.clientMessageId)) {
    throw new Error(`Message submission already exists: ${input.clientMessageId}`);
  }
  return [...submissions, { ...input, rpcAccepted: false, providerAcknowledged: false }];
}

export function acceptMessageSubmission(
  submissions: readonly MessageSubmissionRecord[],
  clientMessageId: string,
  isAgentRunning: boolean,
): MessageSubmissionRecord[] {
  const index = submissions.findIndex(
    (submission) => submission.clientMessageId === clientMessageId,
  );
  if (index < 0) return submissions as MessageSubmissionRecord[];
  if (isAgentRunning || submissions[index].providerAcknowledged) {
    return submissions.filter((_, submissionIndex) => submissionIndex !== index);
  }
  if (submissions[index].rpcAccepted) return submissions as MessageSubmissionRecord[];
  const next = submissions.slice();
  next[index] = { ...next[index], rpcAccepted: true };
  return next;
}

export function observeAcceptedMessageSubmissionsRunning(
  submissions: readonly MessageSubmissionRecord[],
): MessageSubmissionRecord[] {
  const next = submissions.filter((submission) => !submission.rpcAccepted);
  return next.length === submissions.length ? (submissions as MessageSubmissionRecord[]) : next;
}

export function observeMessageSubmissionCanonical(
  submissions: readonly MessageSubmissionRecord[],
  clientMessageIds: readonly string[],
): MessageSubmissionRecord[] {
  if (clientMessageIds.length === 0) return submissions as MessageSubmissionRecord[];
  const observed = new Set(clientMessageIds);
  let changed = false;
  const next = submissions.flatMap((submission): MessageSubmissionRecord[] => {
    if (submission.providerAcknowledged || !observed.has(submission.clientMessageId)) {
      return [submission];
    }
    changed = true;
    return submission.rpcAccepted ? [] : [{ ...submission, providerAcknowledged: true }];
  });
  return changed ? next : (submissions as MessageSubmissionRecord[]);
}

export function rejectMessageSubmission(
  submissions: readonly MessageSubmissionRecord[],
  clientMessageId: string,
): MessageSubmissionRejectionResult {
  const submission = submissions.find((item) => item.clientMessageId === clientMessageId);
  if (!submission) {
    return { outcome: "unknown", submissions: submissions as MessageSubmissionRecord[] };
  }
  return {
    outcome: submission.providerAcknowledged || submission.rpcAccepted ? "accepted" : "rejected",
    submissions: submissions.filter((item) => item.clientMessageId !== clientMessageId),
  };
}
