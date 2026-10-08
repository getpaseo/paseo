import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";
import type { UserMessageImageAttachment } from "@/types/stream";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  model: string | null;
}

export interface WorkspaceDraftCreateAttempt {
  clientMessageId: string;
  text: string;
  timestamp: Date;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

interface StoredWorkspaceDraftCreateAttempt {
  clientMessageId: string;
  text: string;
  timestamp: number;
  lifecycle: "active" | "abandoned" | "sent";
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
}

export function resolveWorkspaceAutoSubmitAttempt(input: {
  clientMessageId: string;
  renderedAttempt: WorkspaceDraftCreateAttempt | null;
  latestStoredAttempt: StoredWorkspaceDraftCreateAttempt | null;
}): WorkspaceDraftCreateAttempt | null {
  if (input.renderedAttempt?.clientMessageId === input.clientMessageId) {
    return input.renderedAttempt;
  }
  const stored = input.latestStoredAttempt;
  if (
    !stored ||
    stored.lifecycle !== "active" ||
    stored.clientMessageId !== input.clientMessageId
  ) {
    return null;
  }
  return {
    clientMessageId: stored.clientMessageId,
    text: stored.text,
    timestamp: new Date(stored.timestamp),
    ...(stored.images && stored.images.length > 0 ? { images: stored.images } : {}),
    ...(stored.attachments && stored.attachments.length > 0
      ? { attachments: stored.attachments }
      : {}),
  };
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  hasClient: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}
