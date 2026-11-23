import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { renderPromptAttachmentAsText } from "@getpaseo/protocol/prompt-attachment-text";
import type { AgentPromptContentBlock, AgentPromptInput } from "./agent-sdk-types.js";

export { renderPromptAttachmentAsText };

export function buildAgentPrompt(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
  attachments?: AgentAttachment[],
): AgentPromptInput {
  const normalized = text.trim();
  const hasImages = (images?.length ?? 0) > 0;
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!hasImages && !hasAttachments) {
    return normalized;
  }

  const chatHistoryAttachments: AgentAttachment[] = [];
  const otherAttachments: AgentAttachment[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.type === "text" && attachment.contextKind === "chat_history") {
      chatHistoryAttachments.push(attachment);
    } else {
      otherAttachments.push(attachment);
    }
  }

  const blocks: AgentPromptContentBlock[] = [...chatHistoryAttachments];
  if (normalized.length > 0) {
    blocks.push({ type: "text", text: normalized });
  }
  for (const image of images ?? []) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  blocks.push(...otherAttachments);
  return blocks;
}

export function buildAgentBranchNameSeed(
  firstAgentContext: { prompt?: string; attachments?: readonly AgentAttachment[] } | undefined,
): string | undefined {
  if (!firstAgentContext) {
    return undefined;
  }
  const parts: string[] = [];
  const prompt = firstAgentContext.prompt?.trim();
  if (prompt) {
    parts.push(["<user-prompt>", prompt, "</user-prompt>"].join("\n"));
  }
  const renderedAttachments: string[] = [];
  for (const attachment of firstAgentContext.attachments ?? []) {
    const rendered = renderPromptAttachmentAsText(attachment).trim();
    if (rendered) {
      renderedAttachments.push(rendered);
    }
  }
  if (renderedAttachments.length > 0) {
    parts.push(["<attachments>", renderedAttachments.join("\n\n"), "</attachments>"].join("\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
