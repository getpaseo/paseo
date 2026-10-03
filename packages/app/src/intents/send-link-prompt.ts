import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { generateMessageId } from "@/types/stream";

export class LinkPromptHostOfflineError extends Error {
  constructor() {
    super("Host offline");
    this.name = "LinkPromptHostOfflineError";
  }
}

/**
 * Delivers a link prompt straight to the daemon. The composer's optimistic
 * row is skipped on purpose: the daemon echoes the user message back on the
 * stream, and the agent tab opens right after, so the user sees it land.
 */
export async function sendLinkPrompt(input: {
  serverId: string;
  agentId: string;
  text: string;
}): Promise<void> {
  const client = getHostRuntimeStore().getClient(input.serverId);
  if (!client?.isConnected) {
    throw new LinkPromptHostOfflineError();
  }
  await client.sendAgentMessage(input.agentId, input.text, {
    messageId: generateMessageId(),
    images: [],
    attachments: [],
  });
}
