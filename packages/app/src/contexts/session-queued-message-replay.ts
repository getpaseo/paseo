import type { AttachmentMetadata } from "@/attachments/types";

export interface QueuedAgentMessageReplayItem {
  id: string;
  text: string;
  images?: AttachmentMetadata[];
}

export interface QueuedAgentMessageReplay {
  messageId: string;
  text: string;
  images?: AttachmentMetadata[];
  remainingQueue: QueuedAgentMessageReplayItem[];
}

export type QueuedAgentReplaySource = "hydrate" | "live";

export function shouldAutoReplayQueuedAgentMessage(input: {
  previousStatus: string | undefined;
  nextStatus: string;
  source: QueuedAgentReplaySource;
}): boolean {
  return input.source === "live" && input.previousStatus === "running" && input.nextStatus !== "running";
}

export function takeQueuedAgentMessageReplay(
  queue: readonly QueuedAgentMessageReplayItem[] | undefined,
): QueuedAgentMessageReplay | null {
  if (!queue || queue.length === 0) {
    return null;
  }

  const [next, ...remainingQueue] = queue;
  return {
    messageId: next.id,
    text: next.text,
    images: next.images,
    remainingQueue,
  };
}
