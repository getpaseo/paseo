import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import type { AgentContextAttachment, ComposerAttachment } from "@/attachments/types";

type AgentContextTransferClient = Pick<
  DaemonClient,
  "buildAgentForkContext" | "exportAgentContextTransfer" | "getAgentContextTransferRecipient"
>;

type HostFeatures = NonNullable<ServerInfoStatusPayload["features"]>;

export interface AgentContextSubmitRuntime {
  getClient(serverId: string): AgentContextTransferClient | null;
  getFeatures(serverId: string): HostFeatures | undefined;
}

type CrossHostAgentContextAttachment = AgentContextAttachment & {
  crossHost: NonNullable<AgentContextAttachment["crossHost"]>;
};

function isCrossHostAgentContextAttachment(
  attachment: ComposerAttachment,
): attachment is CrossHostAgentContextAttachment {
  return attachment.kind === "agent_context" && attachment.crossHost !== undefined;
}

function requireSourceClient(
  runtime: AgentContextSubmitRuntime,
  sourceServerId: string,
): AgentContextTransferClient {
  const client = runtime.getClient(sourceServerId);
  if (!client) {
    throw new Error("Connect the source host before attaching its agent context.");
  }
  return client;
}

async function prepareSecureAttachment(input: {
  attachment: CrossHostAgentContextAttachment;
  destinationServerId: string;
  runtime: AgentContextSubmitRuntime;
  getRecipient: () => Promise<{ serverId: string; publicKeyB64: string }>;
}): Promise<AgentContextAttachment> {
  const sourceServerId = input.attachment.source.serverId;
  const sourceFeatures = input.runtime.getFeatures(sourceServerId);
  const destinationFeatures = input.runtime.getFeatures(input.destinationServerId);
  const canTransferSecurely =
    sourceFeatures?.agentContextTransfer === true &&
    destinationFeatures?.agentContextTransfer === true;
  if (!canTransferSecurely) {
    throw new Error(
      "Secure cross-host context is no longer available. Reattach the agent to choose compatibility transfer.",
    );
  }
  const sourceClient = requireSourceClient(input.runtime, sourceServerId);
  const destination = await input.getRecipient();
  if (destination.serverId !== input.destinationServerId) {
    throw new Error("Destination host identity changed. Reconnect it and try again.");
  }
  const transfer = await sourceClient.exportAgentContextTransfer({
    agentId: input.attachment.source.agentId,
    destination,
  });
  return { ...input.attachment, transfer };
}

async function prepareCompatibilityAttachment(input: {
  attachment: CrossHostAgentContextAttachment;
  runtime: AgentContextSubmitRuntime;
}): Promise<ComposerAttachment> {
  if (
    input.attachment.crossHost.mode !== "compatibility" ||
    input.attachment.crossHost.userConfirmed !== true
  ) {
    throw new Error("Compatibility transfer requires explicit confirmation.");
  }
  const sourceServerId = input.attachment.source.serverId;
  if (input.runtime.getFeatures(sourceServerId)?.agentForkContext !== true) {
    throw new Error(
      "The source host is too old to export curated agent context. Update it and reattach the agent.",
    );
  }
  const sourceClient = requireSourceClient(input.runtime, sourceServerId);
  const forkContext = await sourceClient.buildAgentForkContext(input.attachment.source.agentId);
  if (!forkContext.attachment) {
    throw new Error("The source host did not return curated agent context.");
  }
  return {
    kind: "chat_history",
    id: `agent-context-compatibility:${sourceServerId}:${input.attachment.source.agentId}`,
    attachment: forkContext.attachment,
    source: {
      serverId: sourceServerId,
      agentId: input.attachment.source.agentId,
      ...(forkContext.boundaryMessageId !== undefined
        ? { boundaryMessageId: forkContext.boundaryMessageId }
        : {}),
      ...(forkContext.boundaryCursor !== undefined
        ? { boundaryCursor: forkContext.boundaryCursor }
        : {}),
      ...(forkContext.itemCount !== undefined ? { itemCount: forkContext.itemCount } : {}),
    },
  };
}

export async function prepareAgentContextAttachmentsForSubmit(input: {
  attachments: readonly ComposerAttachment[];
  destinationServerId: string;
  runtime?: AgentContextSubmitRuntime;
}): Promise<ComposerAttachment[]> {
  const crossHostAttachments = input.attachments.filter(isCrossHostAgentContextAttachment);
  if (crossHostAttachments.length === 0) {
    return [...input.attachments];
  }
  if (!input.runtime) {
    throw new Error("Cross-host agent context submit runtime is unavailable.");
  }
  const runtime: AgentContextSubmitRuntime = input.runtime;
  for (const attachment of crossHostAttachments) {
    if (attachment.source.serverId === input.destinationServerId) {
      throw new Error("Same-host agent context must use a local reference.");
    }
    if (attachment.crossHost.destinationServerId !== input.destinationServerId) {
      throw new Error("This agent context was attached for another destination host.");
    }
  }

  let recipientPromise: Promise<{ serverId: string; publicKeyB64: string }> | null = null;
  function getRecipient() {
    if (!recipientPromise) {
      const destinationClient = runtime.getClient(input.destinationServerId);
      if (!destinationClient) {
        throw new Error("Connect the destination host before sending agent context.");
      }
      recipientPromise = destinationClient.getAgentContextTransferRecipient();
    }
    return recipientPromise;
  }

  return Promise.all(
    input.attachments.map(async (attachment): Promise<ComposerAttachment> => {
      if (!isCrossHostAgentContextAttachment(attachment)) {
        return attachment;
      }
      if (attachment.crossHost.mode === "secure") {
        return prepareSecureAttachment({
          attachment,
          destinationServerId: input.destinationServerId,
          runtime,
          getRecipient,
        });
      }
      return prepareCompatibilityAttachment({ attachment, runtime });
    }),
  );
}
