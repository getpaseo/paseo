const NOTIFICATION_PREVIEW_LIMIT = 220;

export type AgentAttentionReason = "finished" | "error" | "permission";

export type AgentAttentionNotificationData = {
  serverId: string;
  agentId: string;
  reason: AgentAttentionReason;
};

export type AgentAttentionNotificationPayload = {
  title: string;
  body: string;
  data: AgentAttentionNotificationData;
};

type BuildAgentAttentionNotificationPayloadInput = {
  reason: AgentAttentionReason;
  serverId: string;
  agentId: string;
  assistantMessage?: string | null;
  permissionRequest?: NotificationPermissionRequest | null;
};

export type NotificationPermissionRequest = {
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type AssistantTimelineItem =
  | { type: "assistant_message"; text: string }
  | { type: string; text?: string };

const normalizeNotificationText = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const truncateNotificationText = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }
  const trimmed = text.slice(0, Math.max(0, limit - 3)).trimEnd();
  return trimmed.length > 0 ? `${trimmed}...` : text.slice(0, limit);
};

const stripMarkdownToText = (markdown: string): string => {
  let text = markdown.replace(/\r\n/g, "\n");

  // Strip fenced code markers but keep the code content itself.
  text = text.replace(/^\s*```[^\n]*$/gm, "");
  text = text.replace(/^\s*~~~[^\n]*$/gm, "");

  // Markdown links/images.
  text = text.replace(/!\[([^\]]*)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:[^()\\]|\\.)*\)/g, "$1");

  // Structural prefixes.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>+\s?/gm, "");
  text = text.replace(/^\s{0,3}(?:[*+-]|\d+\.)\s+/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "");

  // Inline markdown markers.
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/_([^_\n]+)_/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Angle-bracketed URL autolinks.
  text = text.replace(/<([^>\n]+)>/g, "$1");

  return text;
};

const buildNotificationPreview = (
  text: string | null | undefined
): string | null => {
  if (!text) {
    return null;
  }

  const normalized = normalizeNotificationText(stripMarkdownToText(text));
  if (!normalized) {
    return null;
  }

  return truncateNotificationText(normalized, NOTIFICATION_PREVIEW_LIMIT);
};

const safeStringify = (value: unknown): string | null => {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const buildPermissionDetails = (
  request: NotificationPermissionRequest | null | undefined
): string | null => {
  if (!request) {
    return null;
  }

  const title = request.title?.trim();
  const description = request.description?.trim();
  const details: string[] = [];

  if (title) {
    details.push(title);
  }
  if (description && description !== title) {
    details.push(description);
  }
  if (details.length > 0) {
    return details.join(" - ");
  }

  const inputPreview = request.input ? safeStringify(request.input) : null;
  if (inputPreview) {
    return inputPreview;
  }

  const metadataPreview = request.metadata ? safeStringify(request.metadata) : null;
  if (metadataPreview) {
    return metadataPreview;
  }

  return request.name?.trim() || request.kind;
};

export function findLatestAssistantMessageFromTimeline(
  timeline: readonly AssistantTimelineItem[]
): string | null {
  // Providers may stream assistant content in consecutive chunks.
  const chunks: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type !== "assistant_message" || typeof item.text !== "string") {
      if (chunks.length > 0) {
        break;
      }
      continue;
    }
    chunks.push(item.text);
  }

  if (chunks.length === 0) {
    return null;
  }

  return chunks.reverse().join("");
}

export function findLatestPermissionRequest(
  pendingPermissions: ReadonlyMap<string, NotificationPermissionRequest>
): NotificationPermissionRequest | null {
  let latest: NotificationPermissionRequest | null = null;
  for (const request of pendingPermissions.values()) {
    latest = request;
  }
  return latest;
}

export function buildAgentAttentionNotificationPayload(
  input: BuildAgentAttentionNotificationPayloadInput
): AgentAttentionNotificationPayload {
  const title =
    input.reason === "permission"
      ? "Agent needs permission"
      : input.reason === "error"
        ? "Agent needs attention"
        : "Agent finished";

  const preview =
    input.reason === "finished"
      ? buildNotificationPreview(input.assistantMessage)
      : input.reason === "permission"
        ? buildNotificationPreview(buildPermissionDetails(input.permissionRequest))
        : null;

  const body =
    preview ??
    (input.reason === "permission"
      ? "Permission requested."
      : input.reason === "error"
        ? "Encountered an error."
        : "Finished working.");

  return {
    title,
    body,
    data: {
      serverId: input.serverId,
      agentId: input.agentId,
      reason: input.reason,
    },
  };
}
