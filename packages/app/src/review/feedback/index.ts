import type { ComposerAttachment } from "@/attachments/types";
import type { ReviewDraftComment } from "../state";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

export interface FeedbackRecipient {
  agentId: string;
  tab: WorkspaceTabDescriptor;
}
export type FeedbackAttachment = Extract<ComposerAttachment, { kind: "review" }>;
export interface ReviewFeedbackSnapshot {
  comments: readonly ReviewDraftComment[];
  attachment: FeedbackAttachment | null;
  recipients: readonly FeedbackRecipient[];
  connected: boolean;
}
export interface ReviewFeedbackPorts {
  read: () => ReviewFeedbackSnapshot;
  send: (recipient: FeedbackRecipient, attachment: FeedbackAttachment) => Promise<void>;
  clearSent: (comments: readonly ReviewDraftComment[]) => void;
  failedMessage: () => string;
}
export type FeedbackPhase =
  | { kind: "idle" }
  | { kind: "choosing" }
  | { kind: "sending"; recipient: FeedbackRecipient; commentCount: number }
  | { kind: "failed"; message: string }
  | { kind: "sent"; recipient: FeedbackRecipient };
export interface ReviewFeedbackState {
  phase: FeedbackPhase;
  commentCount: number;
  sendableCommentCount: number;
  recipients: readonly FeedbackRecipient[];
  disabledReason: "no-agents" | "disconnected" | "no-context" | null;
  canSend: boolean;
}

export function createReviewFeedback(ports: ReviewFeedbackPorts) {
  let phase: FeedbackPhase = { kind: "idle" };
  let state = deriveState(ports.read(), phase);
  const listeners = new Set<() => void>();
  function publish() {
    state = deriveState(ports.read(), phase);
    listeners.forEach((listener) => listener());
  }
  async function send(agentId: string) {
    const snapshot = ports.read();
    const current = deriveState(snapshot, phase);
    const recipient = snapshot.recipients.find((candidate) => candidate.agentId === agentId);
    if (!current.canSend || !recipient || !snapshot.attachment) return;
    const attachment = snapshot.attachment;
    const sentComments = snapshot.comments.filter((comment) =>
      attachment.attachment.comments.some(
        (sent) =>
          sent.filePath === comment.filePath &&
          sent.side === comment.side &&
          sent.lineNumber === comment.lineNumber &&
          sent.body === comment.body,
      ),
    );
    phase = { kind: "sending", recipient, commentCount: attachment.commentCount };
    publish();
    try {
      await ports.send(recipient, attachment);
      ports.clearSent(sentComments);
      phase = { kind: "sent", recipient };
    } catch (error) {
      phase = {
        kind: "failed",
        message: error instanceof Error ? error.message : ports.failedMessage(),
      };
    }
    publish();
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: publish,
    press: async () => {
      const snapshot = ports.read();
      if (!deriveState(snapshot, phase).canSend) return;
      if (snapshot.recipients.length === 1) {
        await send(snapshot.recipients[0]!.agentId);
      } else {
        phase = { kind: "choosing" };
        publish();
      }
    },
    closeMenu: () => {
      if (phase.kind === "choosing") {
        phase = { kind: "idle" };
        publish();
      }
    },
    send,
  };
}

function deriveState(snapshot: ReviewFeedbackSnapshot, phase: FeedbackPhase): ReviewFeedbackState {
  let disabledReason: ReviewFeedbackState["disabledReason"] = null;
  if (snapshot.recipients.length === 0) disabledReason = "no-agents";
  else if (!snapshot.connected) disabledReason = "disconnected";
  else if (!snapshot.attachment) disabledReason = "no-context";
  return {
    phase,
    commentCount: snapshot.comments.length,
    sendableCommentCount: snapshot.attachment?.commentCount ?? 0,
    recipients: snapshot.recipients,
    disabledReason,
    canSend: snapshot.comments.length > 0 && disabledReason === null && phase.kind !== "sending",
  };
}
