import type { InteractiveConversation } from "./context";
import type { SendMessageOptions } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";

export async function sendConversationAction(
  context: InteractiveConversation,
  request: {
    id: string;
    text: string;
    interactiveReference?: SendMessageOptions["interactiveReference"];
    deepenReference?: SendMessageOptions["deepenReference"];
  },
): Promise<"sent" | "queued"> {
  const { client, serverId, agentId } = context;
  if (!client) throw new Error("Host disconnected");
  const store = useSessionStore.getState();
  if (selectAgentTurnPresentation(store.sessions[serverId], agentId).isActive) {
    store.setQueuedMessages(serverId, (previous) => {
      const queue = previous.get(agentId) ?? [];
      if (queue.some((item) => item.id === request.id)) return previous;
      const next = new Map(previous);
      next.set(agentId, [
        ...queue,
        {
          id: request.id,
          text: request.text,
          attachments: [],
          preserveMessageId: true,
          interactiveReference: request.interactiveReference,
          deepenReference: request.deepenReference,
        },
      ]);
      return next;
    });
    return "queued";
  }
  await dispatchComposerAgentMessage({
    client,
    agentId,
    text: request.text,
    messageId: request.id,
    interactiveReference: request.interactiveReference,
    deepenReference: request.deepenReference,
    attachments: [],
    encodeImages: async () => undefined,
    submission: createMessageSubmissionWriter(serverId),
    activeTurnBehavior: "queue",
  });
  return "sent";
}
