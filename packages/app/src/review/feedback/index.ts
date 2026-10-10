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
  return createFeedbackView(ports, createFeedbackWorkflow());
}

/** Surfaces share submission ownership while keeping their chooser and live inputs local. */
export function createReviewFeedbackScope() {
  const workflows = new Map<string, ReturnType<typeof createFeedbackWorkflow>>();
  return {
    connect(key: string, ports: ReviewFeedbackPorts) {
      let workflow = workflows.get(key);
      if (!workflow) {
        const created = createFeedbackWorkflow(() => {
          if (workflows.get(key) === created) workflows.delete(key);
        });
        workflow = created;
        workflows.set(key, workflow);
      }
      return createFeedbackView(ports, workflow);
    },
  };
}

function createFeedbackWorkflow(onUnused: () => void = () => {}) {
  let phase: FeedbackPhase = { kind: "idle" };
  const observers = new Set<() => void>();
  function releaseIfUnused() {
    queueMicrotask(() => {
      if (observers.size === 0 && phase.kind !== "sending") onUnused();
    });
  }
  return {
    getPhase: () => phase,
    changePhase(next: FeedbackPhase) {
      phase = next;
      observers.forEach((observer) => observer());
      releaseIfUnused();
    },
    subscribe(observer: () => void) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
        releaseIfUnused();
      };
    },
  };
}

function createFeedbackView(
  ports: ReviewFeedbackPorts,
  workflow: ReturnType<typeof createFeedbackWorkflow>,
) {
  let choosing = false;
  const choosingPhase: FeedbackPhase = { kind: "choosing" };
  const getPhase = () => (choosing ? choosingPhase : workflow.getPhase());
  let state = deriveState(ports.read(), getPhase());
  const listeners = new Set<() => void>();
  function publish() {
    state = deriveState(ports.read(), getPhase());
    listeners.forEach((listener) => listener());
  }
  async function send(agentId: string) {
    const snapshot = ports.read();
    const current = deriveState(snapshot, workflow.getPhase());
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
    choosing = false;
    workflow.changePhase({ kind: "sending", recipient, commentCount: attachment.commentCount });
    publish();
    try {
      await ports.send(recipient, attachment);
      ports.clearSent(sentComments);
      workflow.changePhase({ kind: "sent", recipient });
    } catch (error) {
      workflow.changePhase({
        kind: "failed",
        message: error instanceof Error ? error.message : ports.failedMessage(),
      });
    }
    publish();
  }
  return {
    getState: () => {
      if (state.phase !== getPhase()) state = deriveState(ports.read(), getPhase());
      return state;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      const unsubscribe = workflow.subscribe(() => {
        choosing = false;
        publish();
      });
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
    refresh: publish,
    press: async () => {
      const snapshot = ports.read();
      if (!deriveState(snapshot, workflow.getPhase()).canSend) return;
      if (snapshot.recipients.length === 1) {
        await send(snapshot.recipients[0]!.agentId);
      } else {
        choosing = true;
        publish();
      }
    },
    closeMenu: () => {
      if (choosing) {
        choosing = false;
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
