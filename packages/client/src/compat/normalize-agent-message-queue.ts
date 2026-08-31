import {
  normalizeAgentAttachments,
  type AgentAttachment,
  type QueuedAgentMessagePayload,
  type QueuedAgentMessageQueuePayload,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

export type NormalizedQueuedAgentMessagePayload = Omit<
  QueuedAgentMessagePayload,
  "images" | "attachments" | "imageCount" | "attachmentCount"
> & {
  images: NonNullable<QueuedAgentMessagePayload["images"]>;
  attachments: AgentAttachment[];
  imageCount: number;
  attachmentCount: number;
};

export type NormalizedQueuedAgentMessageQueuePayload = Omit<
  QueuedAgentMessageQueuePayload,
  "revision" | "messages"
> & {
  revision: number;
  messages: NormalizedQueuedAgentMessagePayload[];
};

export function normalizeQueuedAgentMessagePayload(
  payload: QueuedAgentMessagePayload,
): NormalizedQueuedAgentMessagePayload {
  const images = payload.images ?? [];
  const attachments = normalizeAgentAttachments(payload.attachments);
  const wireAttachmentCount = payload.attachments?.length ?? 0;
  return {
    ...payload,
    images,
    attachments,
    imageCount: payload.imageCount ?? images.length,
    attachmentCount: payload.attachmentCount ?? wireAttachmentCount,
  };
}

export function normalizeQueuedAgentMessageQueuePayload(
  payload: QueuedAgentMessageQueuePayload,
): NormalizedQueuedAgentMessageQueuePayload {
  return {
    ...payload,
    revision: payload.revision ?? 0,
    messages: payload.messages.map(normalizeQueuedAgentMessagePayload),
  };
}

export function normalizeAgentMessageQueueMessage(
  message: SessionOutboundMessage,
): SessionOutboundMessage {
  if (message.type === "queue.agent_message.updated") {
    return {
      ...message,
      payload: normalizeQueuedAgentMessageQueuePayload(message.payload),
    };
  }
  if (message.type === "queue.agent_message.list.response") {
    return {
      ...message,
      payload: {
        ...message.payload,
        queues: message.payload.queues.map(normalizeQueuedAgentMessageQueuePayload),
      },
    };
  }
  if (message.type === "queue.agent_message.enqueue.response" && message.payload.message) {
    return {
      ...message,
      payload: {
        ...message.payload,
        message: normalizeQueuedAgentMessagePayload(message.payload.message),
      },
    };
  }
  return message;
}
