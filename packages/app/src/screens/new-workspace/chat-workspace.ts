import type { CreateAgentRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";

interface ChatWorkspaceComposerState {
  selectedMode: string;
  effectiveModelId: string | null;
  effectiveThinkingOptionId: string | null;
  featureValues: Record<string, unknown> | undefined;
}

export function isEmptyChatWorkspaceSubmission(text: string): boolean {
  return text.trim().length === 0;
}

export function buildChatWorkspaceCreateAgentOptions(input: {
  provider: AgentProvider;
  composerState: ChatWorkspaceComposerState;
  text: string;
  clientMessageId: string;
  images: CreateAgentRequestOptions["images"];
  attachments: AgentAttachment[];
}): CreateAgentRequestOptions {
  const config = buildWorkspaceDraftAgentConfig({
    provider: input.provider,
    cwd: "",
    modeId: input.composerState.selectedMode || undefined,
    model: input.composerState.effectiveModelId || undefined,
    thinkingOptionId: input.composerState.effectiveThinkingOptionId || undefined,
    featureValues: input.composerState.featureValues,
  });

  return {
    config,
    chatWorkspace: true,
    initialPrompt: input.text.trim(),
    clientMessageId: input.clientMessageId,
    ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
  };
}
