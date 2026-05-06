import type { GitHubSearchItem } from "@server/shared/messages";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
} from "@/attachments/types";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
} from "@/attachments/workspace-attachment-utils";
import { splitComposerAttachmentsForSubmit } from "@/components/composer-attachments";
import { generateMessageId, type StreamItem } from "@/types/stream";
import type { PickedImageAttachmentInput } from "@/hooks/image-attachment-picker";

export interface QueuedComposerMessage {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
}

export interface AttachmentPersister {
  persistFromBlob: (input: {
    blob: Blob;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  persistFromFileUri: (input: {
    uri: string;
    mimeType: string;
    fileName: string | null;
  }) => Promise<AttachmentMetadata>;
  deleteAttachments: (metadata: AttachmentMetadata[]) => Promise<void> | void;
}

export interface ComposerSendClient {
  sendAgentMessage: (
    agentId: string,
    text: string,
    options: {
      messageId: string;
      images: Array<{ data: string; mimeType: string }>;
      attachments: ReturnType<typeof splitComposerAttachmentsForSubmit>["attachments"];
    },
  ) => Promise<void>;
}

export interface ComposerCancelClient {
  cancelAgent: (agentId: string) => Promise<void> | void;
}

export interface AgentStreamWriter {
  getHead: (agentId: string) => StreamItem[] | undefined;
  setHead: (updater: (prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>) => void;
  setTail: (updater: (prev: Map<string, StreamItem[]>) => Map<string, StreamItem[]>) => void;
}

export interface QueueWriter {
  read: (agentId: string) => QueuedComposerMessage[];
  write: (
    updater: (prev: Map<string, QueuedComposerMessage[]>) => Map<string, QueuedComposerMessage[]>,
  ) => void;
}

export async function pickAndPersistImages(input: {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
  persister: Pick<AttachmentPersister, "persistFromBlob" | "persistFromFileUri">;
}): Promise<AttachmentMetadata[]> {
  const result = await input.pickImages();
  if (!result?.length) return [];
  return await Promise.all(
    result.map(async (picked) => {
      const fileName = picked.fileName ?? null;
      const mimeType = picked.mimeType || "image/jpeg";
      if (picked.source.kind === "blob") {
        return await input.persister.persistFromBlob({
          blob: picked.source.blob,
          mimeType,
          fileName,
        });
      }
      return await input.persister.persistFromFileUri({
        uri: picked.source.uri,
        mimeType,
        fileName,
      });
    }),
  );
}

export function removeComposerAttachmentAtIndex<T extends ComposerAttachment>(input: {
  attachments: T[];
  index: number;
  deleteAttachments: AttachmentPersister["deleteAttachments"];
}): T[] {
  const removed = input.attachments[input.index];
  if (removed?.kind === "image") {
    void input.deleteAttachments([removed.metadata]);
  }
  return input.attachments.filter((_, i) => i !== input.index);
}

export interface CancelComposerAgentInput {
  client: ComposerCancelClient | null;
  agentId: string;
  isAgentRunning: boolean;
  isCancellingAgent: boolean;
  isConnected: boolean;
}

export function cancelComposerAgent(input: CancelComposerAgentInput): boolean {
  if (!input.isAgentRunning || input.isCancellingAgent) return false;
  if (!input.isConnected || !input.client) return false;
  void input.client.cancelAgent(input.agentId);
  return true;
}

export interface DispatchComposerAgentMessageInput {
  client: ComposerSendClient;
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  encodeImages: (
    images: AttachmentMetadata[],
  ) => Promise<Array<{ data: string; mimeType: string }> | undefined>;
  stream: AgentStreamWriter;
}

export async function dispatchComposerAgentMessage(
  input: DispatchComposerAgentMessageInput,
): Promise<void> {
  const wirePayload = splitComposerAttachmentsForSubmit(input.attachments);
  const messageId = generateMessageId();
  const userMessage: StreamItem = {
    kind: "user_message",
    id: messageId,
    text: input.text,
    timestamp: new Date(),
    ...(wirePayload.images.length > 0 ? { images: wirePayload.images } : {}),
    ...(wirePayload.attachments.length > 0 ? { attachments: wirePayload.attachments } : {}),
  };
  appendUserMessageToStream(input.agentId, userMessage, input.stream);
  const imagesData = await input.encodeImages(wirePayload.images);
  await input.client.sendAgentMessage(input.agentId, input.text, {
    messageId,
    images: imagesData ?? [],
    attachments: wirePayload.attachments,
  });
}

function appendUserMessageToStream(
  agentId: string,
  userMessage: StreamItem,
  stream: AgentStreamWriter,
): void {
  const head = stream.getHead(agentId);
  if (head && head.length > 0) {
    stream.setHead((prev) => {
      const next = new Map(prev);
      next.set(agentId, [...(prev.get(agentId) ?? []), userMessage]);
      return next;
    });
    return;
  }
  stream.setTail((prev) => {
    const next = new Map(prev);
    next.set(agentId, [...(prev.get(agentId) ?? []), userMessage]);
    return next;
  });
}

export interface QueueComposerMessageInput {
  agentId: string;
  text: string;
  attachments: ComposerAttachment[];
  queue: QueueWriter;
}

export interface QueueComposerMessageResult {
  queued: QueuedComposerMessage | null;
}

export function queueComposerMessage(input: QueueComposerMessageInput): QueueComposerMessageResult {
  const trimmed = input.text.trim();
  if (!trimmed && input.attachments.length === 0) {
    return { queued: null };
  }
  const item: QueuedComposerMessage = {
    id: generateMessageId(),
    text: trimmed,
    attachments: input.attachments,
  };
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(input.agentId, [...(prev.get(input.agentId) ?? []), item]);
    return next;
  });
  return { queued: item };
}

export interface EditQueuedComposerMessageInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
}

export interface EditQueuedComposerMessageResult {
  text: string;
  attachments: UserComposerAttachment[];
}

export function editQueuedComposerMessage(
  input: EditQueuedComposerMessageInput,
): EditQueuedComposerMessageResult | null {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return null;
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((q) => q.id !== input.messageId),
    );
    return next;
  });
  return {
    text: item.text,
    attachments: userAttachmentsOnly(item.attachments),
  };
}

export interface SendQueuedComposerMessageNowInput {
  agentId: string;
  messageId: string;
  queue: QueueWriter;
  submitMessage: (input: { text: string; attachments: ComposerAttachment[] }) => Promise<void>;
}

export type SendQueuedComposerMessageNowResult =
  | { status: "missing" }
  | { status: "submitted" }
  | { status: "failed"; errorMessage: string };

export async function sendQueuedComposerMessageNow(
  input: SendQueuedComposerMessageNowInput,
): Promise<SendQueuedComposerMessageNowResult> {
  const item = input.queue.read(input.agentId).find((q) => q.id === input.messageId);
  if (!item) return { status: "missing" };
  input.queue.write((prev) => {
    const next = new Map(prev);
    next.set(
      input.agentId,
      (prev.get(input.agentId) ?? []).filter((q) => q.id !== input.messageId),
    );
    return next;
  });
  try {
    await input.submitMessage({ text: item.text, attachments: item.attachments });
    return { status: "submitted" };
  } catch (error) {
    input.queue.write((prev) => {
      const next = new Map(prev);
      next.set(input.agentId, [item, ...(prev.get(input.agentId) ?? [])]);
      return next;
    });
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Failed to send message",
    };
  }
}

export interface OpenComposerAttachmentInput {
  attachment: ComposerAttachment;
  setLightboxMetadata: (metadata: AttachmentMetadata) => void;
  openWorkspaceAttachment: (input: { attachment: ComposerAttachment }) => boolean;
  openExternalUrl: (url: string) => void;
}

export function openComposerAttachment(input: OpenComposerAttachmentInput): void {
  if (input.attachment.kind === "image") {
    input.setLightboxMetadata(input.attachment.metadata);
    return;
  }
  if (isWorkspaceAttachment(input.attachment)) {
    input.openWorkspaceAttachment({ attachment: input.attachment });
    return;
  }
  input.openExternalUrl(input.attachment.item.url);
}

export function buildGithubAttachment(item: GitHubSearchItem): UserComposerAttachment {
  return item.kind === "pr" ? { kind: "github_pr", item } : { kind: "github_issue", item };
}

export function toggleGithubAttachment(
  current: UserComposerAttachment[],
  item: GitHubSearchItem,
): UserComposerAttachment[] {
  const matches = (attachment: UserComposerAttachment) =>
    attachment.kind !== "image" &&
    attachment.item.kind === item.kind &&
    attachment.item.number === item.number;
  if (current.some(matches)) {
    return current.filter((attachment) => !matches(attachment));
  }
  return [...current, buildGithubAttachment(item)];
}

export function findGithubItemByOption(
  items: readonly GitHubSearchItem[],
  optionId: string,
): GitHubSearchItem | undefined {
  return items.find((candidate) => `${candidate.kind}:${candidate.number}` === optionId);
}

export function isAttachmentSelectedForGithubItem(
  current: readonly ComposerAttachment[],
  item: GitHubSearchItem,
): boolean {
  return userAttachmentsOnly(current).some(
    (attachment) =>
      attachment.kind !== "image" &&
      attachment.item.kind === item.kind &&
      attachment.item.number === item.number,
  );
}
