import type {
  CreateAgentRequestOptions,
  CreateWorkspaceRequestOptions,
} from "@getpaseo/client/internal/daemon-client";

export type WorkspaceAgentRequest = NonNullable<CreateWorkspaceRequestOptions["agent"]>;

/**
 * The agent a retried creation asks for: everything the draft resubmitted (config, prompt,
 * images, attachments and metadata, cleared included) on the first attempt's identity, so a
 * retry creates what the composer shows now, not what it showed when creation first failed.
 */
export function retriedAgentRequest(
  initial: WorkspaceAgentRequest,
  request: CreateAgentRequestOptions,
  cwd: string,
): WorkspaceAgentRequest {
  const { metadata: _replaced, ...identity } = initial;
  return {
    ...identity,
    config: { ...request.config!, cwd },
    initialPrompt: request.initialPrompt ?? "",
    clientMessageId: initial.clientMessageId,
    images: request.images,
    attachments: request.attachments,
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}
