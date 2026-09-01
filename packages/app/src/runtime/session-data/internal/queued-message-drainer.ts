import { dispatchComposerAgentMessage, sendQueuedComposerMessageNow } from "@/composer/actions";
import { resolveComposerAttachmentSubmitFormat } from "@/composer/attachments/submit";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useSessionStore } from "@/stores/session-store";
import { encodeImages } from "@/utils/encode-images";

export class QueuedMessageDrainer {
  private readonly inFlight = new Set<string>();

  drain(serverId: string, agentId: string): void {
    const drainKey = `${serverId}:${agentId}`;
    if (this.inFlight.has(drainKey)) return;
    const session = useSessionStore.getState().sessions[serverId];
    const queue = session?.queuedMessages.get(agentId);
    const client = session?.client;
    if (!client || !queue?.length || session.initializingAgents.get(agentId) === true) return;

    this.inFlight.add(drainKey);
    const next = queue[0];
    void sendQueuedComposerMessageNow({
      agentId,
      messageId: next.id,
      queue: {
        read: (queuedAgentId) =>
          useSessionStore.getState().sessions[serverId]?.queuedMessages.get(queuedAgentId) ?? [],
        write: (update) => useSessionStore.getState().setQueuedMessages(serverId, update),
      },
      submitMessage: async ({ text, attachments }) => {
        const supportsForgeAttachments =
          useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.forgeSearch === true;
        await dispatchComposerAgentMessage({
          client,
          agentId,
          text,
          attachments,
          attachmentSubmitFormat: resolveComposerAttachmentSubmitFormat({
            supportsForgeAttachments,
          }),
          encodeImages,
          submission: createMessageSubmissionWriter(serverId),
        });
      },
    })
      .then((result) => {
        if (result.status === "failed") {
          console.error("[SessionData] failed to drain queued agent message", {
            serverId,
            agentId,
            error: result.errorMessage,
          });
        }
        return result;
      })
      .finally(() => this.inFlight.delete(drainKey));
  }
}
