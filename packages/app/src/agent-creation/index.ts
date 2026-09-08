import type {
  DaemonClient,
  CreateAgentRequestOptions,
} from "@getpaseo/client/internal/daemon-client";

/** Creation and prompt delivery have separate durable receipts on the daemon. */
export async function createAgentWithInitialMessage(
  client: Pick<DaemonClient, "createAgent" | "sendMessage">,
  options: Omit<CreateAgentRequestOptions, "outputSchema"> & {
    idempotencyKey: string;
    clientMessageId: string;
  },
) {
  const { initialPrompt = "", clientMessageId, images, attachments, ...creation } = options;
  const agent = await client.createAgent(creation);
  if (initialPrompt || images?.length || attachments?.length) {
    await client.sendMessage(agent.id, initialPrompt, {
      messageId: clientMessageId,
      images,
      attachments,
    });
  }
  return agent;
}
