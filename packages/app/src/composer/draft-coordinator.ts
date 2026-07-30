import type { UserComposerAttachment } from "@/attachments/types";
import { getWorkspaceFileAttachmentKey } from "@/attachments/workspace-file";

export interface ComposerDraftSnapshot {
  text: string;
  attachments: UserComposerAttachment[];
}

export type QueuedComposerActionKind = "edit" | "send";

export interface PendingQueuedComposerAction {
  messageId: string;
  action: QueuedComposerActionKind;
}

export type QueuedComposerActionOutcome =
  | { kind: "edited"; draft: ComposerDraftSnapshot }
  | { kind: "sent" }
  | { kind: "failed" };

interface DraftAttempt {
  kind: "draft";
  id: number;
  draft: ComposerDraftSnapshot;
}

interface QueuedAction extends PendingQueuedComposerAction {
  kind: "queued";
}

type PendingAction = DraftAttempt | QueuedAction | null;

interface DraftOwner {
  draft: ComposerDraftSnapshot;
  pending: PendingAction;
  errorMessage: string | null;
}

interface SyncDraftInput {
  ownerId: string;
  draft: ComposerDraftSnapshot;
}

interface SettleDraftAttemptInput {
  ownerId: string;
  attemptId: number;
  outcome: "accepted" | "failed";
}

interface BeginQueuedActionInput {
  ownerId: string;
  currentDraft: ComposerDraftSnapshot;
  messageId: string;
  action: QueuedComposerActionKind;
}

interface SettleQueuedActionInput {
  ownerId: string;
  messageId: string;
  action: QueuedComposerActionKind;
  outcome: QueuedComposerActionOutcome;
}

interface ComposerDraftCoordinator {
  getSnapshot: (ownerId: string) => DraftOwner | undefined;
  subscribe: (listener: () => void) => () => void;
  syncDraft: (input: SyncDraftInput) => void;
  beginDraftAttempt: (input: SyncDraftInput) => number | null;
  settleDraftAttempt: (input: SettleDraftAttemptInput) => ComposerDraftSnapshot | null;
  beginQueuedAction: (input: BeginQueuedActionInput) => boolean;
  settleQueuedAction: (input: SettleQueuedActionInput) => ComposerDraftSnapshot | null;
  setError: (ownerId: string, message: string | null) => void;
}

const EMPTY_DRAFT: ComposerDraftSnapshot = { text: "", attachments: [] };

function copyDraft(draft: ComposerDraftSnapshot): ComposerDraftSnapshot {
  return { text: draft.text, attachments: [...draft.attachments] };
}

function createOwner(draft: ComposerDraftSnapshot): DraftOwner {
  return {
    draft: copyDraft(draft),
    pending: null,
    errorMessage: null,
  };
}

function getAttachmentIdentity(attachment: UserComposerAttachment): string {
  switch (attachment.kind) {
    case "image":
      return `image:${attachment.metadata.id}`;
    case "file":
      return `file:${attachment.attachment.id}`;
    case "workspace_file":
      return `workspace-file:${getWorkspaceFileAttachmentKey(attachment)}`;
    case "plugin_resource":
      return `plugin:${attachment.pluginId}:${attachment.sourceId}:${attachment.item.id}`;
    case "forge_issue":
    case "forge_change_request":
    case "github_issue":
    case "github_pr":
      return `forge:${attachment.item.kind}:${attachment.item.url}`;
  }
}

function haveSameAttachmentIds(
  left: readonly UserComposerAttachment[],
  right: readonly UserComposerAttachment[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((attachment, index) => {
    const candidate = right[index];
    return candidate
      ? getAttachmentIdentity(attachment) === getAttachmentIdentity(candidate)
      : false;
  });
}

function areDraftsEqual(left: ComposerDraftSnapshot, right: ComposerDraftSnapshot): boolean {
  if (left.text !== right.text || left.attachments.length !== right.attachments.length)
    return false;
  return left.attachments.every((attachment, index) => attachment === right.attachments[index]);
}

function isCurrentDraft(current: ComposerDraftSnapshot, attempted: ComposerDraftSnapshot): boolean {
  return (
    current.text.trim() === attempted.text &&
    haveSameAttachmentIds(current.attachments, attempted.attachments)
  );
}

function mergeDrafts(
  older: ComposerDraftSnapshot,
  current: ComposerDraftSnapshot,
): ComposerDraftSnapshot {
  const text = [older.text, current.text].filter((part) => part.length > 0).join("\n\n");
  const seen = new Set<string>();
  const attachments: UserComposerAttachment[] = [];
  for (const attachment of [...older.attachments, ...current.attachments]) {
    const identity = getAttachmentIdentity(attachment);
    if (seen.has(identity)) continue;
    seen.add(identity);
    attachments.push(attachment);
  }
  return { text, attachments };
}

export function createComposerDraftCoordinator(): ComposerDraftCoordinator {
  const owners = new Map<string, DraftOwner>();
  const listeners = new Set<() => void>();
  let nextAttemptId = 1;

  function commit(ownerId: string, owner: DraftOwner): void {
    owners.set(ownerId, owner);
    for (const listener of listeners) listener();
  }

  function getSnapshot(ownerId: string): DraftOwner | undefined {
    return owners.get(ownerId);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return function unsubscribe() {
      listeners.delete(listener);
    };
  }

  function syncDraft(input: SyncDraftInput): void {
    const owner = owners.get(input.ownerId);
    if (!owner) {
      commit(input.ownerId, createOwner(input.draft));
      return;
    }
    if (areDraftsEqual(owner.draft, input.draft)) return;
    commit(input.ownerId, {
      ...owner,
      draft: copyDraft(input.draft),
    });
  }

  function beginDraftAttempt(input: SyncDraftInput): number | null {
    const owner = owners.get(input.ownerId) ?? createOwner(input.draft);
    if (owner.pending || !isCurrentDraft(owner.draft, input.draft)) return null;

    const attempt: DraftAttempt = {
      kind: "draft",
      id: nextAttemptId,
      draft: copyDraft(input.draft),
    };
    nextAttemptId += 1;
    commit(input.ownerId, {
      draft: copyDraft(EMPTY_DRAFT),
      pending: attempt,
      errorMessage: null,
    });
    return attempt.id;
  }

  function settleDraftAttempt(input: SettleDraftAttemptInput): ComposerDraftSnapshot | null {
    const owner = owners.get(input.ownerId);
    if (!owner || owner.pending?.kind !== "draft" || owner.pending.id !== input.attemptId) {
      return null;
    }

    let draft = owner.draft;
    if (input.outcome === "failed") {
      draft = mergeDrafts(owner.pending.draft, owner.draft);
    }
    commit(input.ownerId, {
      ...owner,
      draft,
      pending: null,
    });
    if (input.outcome === "failed") return draft;
    return null;
  }

  function beginQueuedAction(input: BeginQueuedActionInput): boolean {
    const owner = owners.get(input.ownerId) ?? createOwner(input.currentDraft);
    if (owner.pending) return false;
    const action: QueuedAction = {
      kind: "queued",
      messageId: input.messageId,
      action: input.action,
    };
    commit(input.ownerId, {
      ...owner,
      pending: action,
      errorMessage: null,
    });
    return true;
  }

  function settleQueuedAction(input: SettleQueuedActionInput): ComposerDraftSnapshot | null {
    const owner = owners.get(input.ownerId);
    const pending = owner?.pending;
    const matches =
      pending?.kind === "queued" &&
      pending.messageId === input.messageId &&
      pending.action === input.action;
    if (!owner || !matches) return null;

    let draft = owner.draft;
    if (input.outcome.kind === "edited") {
      draft = mergeDrafts(input.outcome.draft, owner.draft);
    }
    commit(input.ownerId, {
      ...owner,
      draft,
      pending: null,
    });
    if (input.outcome.kind === "edited") return draft;
    return null;
  }

  function setError(ownerId: string, message: string | null): void {
    const owner = owners.get(ownerId) ?? createOwner(EMPTY_DRAFT);
    if (owner.errorMessage === message) return;
    commit(ownerId, {
      ...owner,
      errorMessage: message,
    });
  }

  return {
    getSnapshot,
    subscribe,
    syncDraft,
    beginDraftAttempt,
    settleDraftAttempt,
    beginQueuedAction,
    settleQueuedAction,
    setError,
  };
}
