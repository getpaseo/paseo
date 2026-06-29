import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import type { WorkspaceComposerAttachment } from "./types";

const EMPTY_WORKSPACE_ATTACHMENTS: readonly WorkspaceComposerAttachment[] = [];

export interface WorkspaceAttachmentScopeInput {
  kind?: "workspace";
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}

export interface DraftWorkspaceAttachmentScopeInput {
  kind: "draft";
  draftId: string;
}

export type WorkspaceAttachmentScope =
  | WorkspaceAttachmentScopeInput
  | DraftWorkspaceAttachmentScopeInput;

interface WorkspaceAttachmentsStoreState {
  attachmentsByScope: Record<string, readonly WorkspaceComposerAttachment[]>;
}

interface WorkspaceAttachmentsStoreActions {
  setWorkspaceAttachments: (input: {
    scopeKey: string;
    attachments: readonly WorkspaceComposerAttachment[];
  }) => void;
  addWorkspaceAttachment: (input: {
    scopeKey: string;
    attachment: WorkspaceComposerAttachment;
  }) => void;
  clearWorkspaceAttachments: (input: { scopeKey: string }) => void;
}

type WorkspaceAttachmentsStore = WorkspaceAttachmentsStoreState & WorkspaceAttachmentsStoreActions;

function encodeScopePart(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}

export function buildWorkspaceAttachmentScopeKey(input: WorkspaceAttachmentScopeInput): string {
  const workspaceId = input.workspaceId?.trim();
  // workspaceId is opaque; do not parse this key back into a path.
  const workspacePart = workspaceId
    ? `workspace=${encodeScopePart(workspaceId)}`
    : `cwd=${encodeScopePart(normalizeCwd(input.cwd))}`;

  return ["workspace-attachments", `server=${encodeScopePart(input.serverId)}`, workspacePart].join(
    ":",
  );
}

export function buildDraftWorkspaceAttachmentScopeKey(draftId: string): string {
  return ["workspace-attachments", `draft=${encodeScopePart(draftId)}`].join(":");
}

function areWorkspaceAttachmentsEqual(
  left: readonly WorkspaceComposerAttachment[],
  right: readonly WorkspaceComposerAttachment[],
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((attachment, index) => attachment === right[index]);
}

function getContextAttachmentKey(attachment: WorkspaceComposerAttachment): string | null {
  const isContextAttachment =
    attachment.kind === "chat_history" ||
    attachment.kind === "github.pull_request_comment" ||
    attachment.kind === "github.pull_request_review" ||
    attachment.kind === "github.pull_request_check";
  if (!isContextAttachment) {
    return null;
  }
  return JSON.stringify({
    kind: attachment.kind,
    id: attachment.id,
  });
}

export function appendWorkspaceAttachment(
  current: readonly WorkspaceComposerAttachment[],
  attachment: WorkspaceComposerAttachment,
): WorkspaceComposerAttachment[] {
  const contextKey = getContextAttachmentKey(attachment);
  if (contextKey === null) {
    return [...current, attachment];
  }

  const next = current.filter(
    (currentAttachment) => getContextAttachmentKey(currentAttachment) !== contextKey,
  );
  return [...next, attachment];
}

export const useWorkspaceAttachmentsStore = create<WorkspaceAttachmentsStore>()((set) => ({
  attachmentsByScope: {},
  setWorkspaceAttachments: ({ scopeKey, attachments }) => {
    set((state) => {
      const current = state.attachmentsByScope[scopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS;
      if (areWorkspaceAttachmentsEqual(current, attachments)) {
        return state;
      }
      if (attachments.length === 0) {
        if (!state.attachmentsByScope[scopeKey]) {
          return state;
        }
        const next = { ...state.attachmentsByScope };
        delete next[scopeKey];
        return { attachmentsByScope: next };
      }
      return {
        attachmentsByScope: {
          ...state.attachmentsByScope,
          [scopeKey]: attachments,
        },
      };
    });
  },
  addWorkspaceAttachment: ({ scopeKey, attachment }) => {
    set((state) => {
      const current = state.attachmentsByScope[scopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS;
      const attachments = appendWorkspaceAttachment(current, attachment);
      if (areWorkspaceAttachmentsEqual(current, attachments)) {
        return state;
      }
      return {
        attachmentsByScope: {
          ...state.attachmentsByScope,
          [scopeKey]: attachments,
        },
      };
    });
  },
  clearWorkspaceAttachments: ({ scopeKey }) => {
    set((state) => {
      if (!state.attachmentsByScope[scopeKey]) {
        return state;
      }
      const next = { ...state.attachmentsByScope };
      delete next[scopeKey];
      return { attachmentsByScope: next };
    });
  },
}));

export function useWorkspaceAttachmentScopeKey(input: WorkspaceAttachmentScope): string {
  const isDraftScope = input.kind === "draft";
  const draftId = isDraftScope ? input.draftId : "";
  const serverId = isDraftScope ? "" : input.serverId;
  const workspaceId = isDraftScope ? undefined : input.workspaceId;
  const cwd = isDraftScope ? "" : input.cwd;
  return useMemo(() => {
    if (isDraftScope) {
      return buildDraftWorkspaceAttachmentScopeKey(draftId);
    }
    return buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd });
  }, [cwd, draftId, isDraftScope, serverId, workspaceId]);
}

export function useDraftWorkspaceAttachmentScopeKey(draftId: string | null | undefined): string {
  const normalizedDraftId = useMemo(() => draftId?.trim() ?? "", [draftId]);
  return useMemo(
    () => (normalizedDraftId ? buildDraftWorkspaceAttachmentScopeKey(normalizedDraftId) : ""),
    [normalizedDraftId],
  );
}

export function useWorkspaceAttachments(scopeKey: string): readonly WorkspaceComposerAttachment[] {
  return useWorkspaceAttachmentsStore(
    (state) => state.attachmentsByScope[scopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS,
  );
}

export function collectWorkspaceAttachmentsForScopes(input: {
  attachmentsByScope: Record<string, readonly WorkspaceComposerAttachment[]>;
  scopeKeys: readonly string[];
}): readonly WorkspaceComposerAttachment[] {
  const attachments: WorkspaceComposerAttachment[] = [];
  for (const scopeKey of input.scopeKeys) {
    const normalizedScopeKey = scopeKey.trim();
    if (!normalizedScopeKey) {
      continue;
    }
    attachments.push(
      ...(input.attachmentsByScope[normalizedScopeKey] ?? EMPTY_WORKSPACE_ATTACHMENTS),
    );
  }
  return attachments;
}

export function useWorkspaceAttachmentsForScopes(
  scopeKeys: readonly string[] | undefined,
): readonly WorkspaceComposerAttachment[] {
  const normalizedScopeKeys = useMemo(
    () => (scopeKeys ?? []).map((scopeKey) => scopeKey.trim()).filter(Boolean),
    [scopeKeys],
  );
  const attachmentsByScope = useWorkspaceAttachmentsStore(
    useShallow((state) => state.attachmentsByScope),
  );
  return useMemo(
    () =>
      collectWorkspaceAttachmentsForScopes({
        attachmentsByScope,
        scopeKeys: normalizedScopeKeys,
      }),
    [attachmentsByScope, normalizedScopeKeys],
  );
}

export function resetWorkspaceAttachmentsStore(): void {
  useWorkspaceAttachmentsStore.setState({ attachmentsByScope: {} });
}
