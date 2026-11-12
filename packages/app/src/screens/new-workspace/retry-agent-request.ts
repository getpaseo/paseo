import type {
  CreateAgentRequestOptions,
  CreateWorkspaceRequestOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { keyedDraftAgentRequest } from "@/composer/draft/creation-key";

export type WorkspaceAgentRequest = NonNullable<CreateWorkspaceRequestOptions["agent"]>;

export async function retryWorkspaceAgentCreation(input: {
  initial: WorkspaceAgentRequest;
  request: CreateAgentRequestOptions;
  cwd: string;
  retryOriginal: () => Promise<AgentSnapshotPayload>;
  createAgent: (request: CreateAgentRequestOptions) => Promise<AgentSnapshotPayload>;
}): Promise<AgentSnapshotPayload> {
  const retried = retriedAgentRequest(input.initial, input.request, input.cwd);
  const original = await keyedDraftAgentRequest("workspace-agent", input.initial);
  const next = await keyedDraftAgentRequest("workspace-agent", retried);
  if (original.idempotencyKey === next.idempotencyKey) return input.retryOriginal();
  // The workspace is already ready. An edited agent intent must not replay its
  // provisioning request with different inputs under the workspace receipt key.
  return input.createAgent(input.request);
}

/** Map the draft back to the source directory before comparing creation intents. */
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
