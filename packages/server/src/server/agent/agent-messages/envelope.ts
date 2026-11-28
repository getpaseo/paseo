import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const agentIdSchema = z.string().min(1);
const changeRequestSourceSchema = z.object({
  kind: z.literal("change-request-update"),
  url: z.url({ protocol: /^https?$/ }),
});
const agentMessageSourceSchema = z.object({
  kind: z.literal("agent-message"),
  agentId: agentIdSchema,
  serverId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});
const agentNotificationSourceSchema = z.object({
  kind: z.literal("agent-notification"),
  agentId: agentIdSchema,
  serverId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  event: z.enum(["finished", "errored", "permission-required", "closed"]),
});
/** Senders a delivery names. A schedule fire is marked by the schedule module alone. */
const promptSourceSchema = z.discriminatedUnion("kind", [
  changeRequestSourceSchema,
  agentMessageSourceSchema,
  agentNotificationSourceSchema,
]);
const markedSourceSchema = z.discriminatedUnion("kind", [
  changeRequestSourceSchema,
  agentMessageSourceSchema,
  agentNotificationSourceSchema,
  z.object({ kind: z.literal("schedule") }),
]);
export type AgentPromptSource = z.infer<typeof promptSourceSchema>;
type MarkedSource = z.infer<typeof markedSourceSchema>;
type AgentNotificationEvent = z.infer<typeof agentNotificationSourceSchema>["event"];

interface AgentMessage {
  id: string;
  /** Null for a person's prompt that needs a marker to keep its own row. */
  source: MarkedSource | null;
  text: string;
}

/** Each notification is its own tool; clients render it from the name and plain-text detail. */
const NOTIFICATION_TOOL_NAMES: Record<AgentNotificationEvent, string> = {
  finished: "agent_finished",
  errored: "agent_errored",
  "permission-required": "agent_needs_permission",
  closed: "agent_closed",
};

/**
 * A marker follows the text it describes, so the prompt's first character stays the sender's
 * (a provider reads slash commands there) and the text needs no escaping. `length` bounds the
 * text, so marker syntax inside a body can never split it.
 */
const MARKER_START = "\n\n<paseo-message ";
const MARKER_PATTERN = /^<paseo-message((?:\s+[a-z-]+="[^"<>]*")+)\/>$/;
/** A person's prompt containing this syntax gets its own marker so it replays as their text. */
const RESERVED_SYNTAX = /<paseo-(?:message|system)\b/;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function unescapeXml(value: string): string | null {
  if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return "'";
    }
  });
}

function markerAttributes(message: AgentMessage): Array<[string, string]> {
  const { source } = message;
  const attributes: Array<[string, string]> = [
    ["kind", source?.kind ?? "user-message"],
    ["message-id", message.id],
  ];
  if (source?.kind === "agent-message" || source?.kind === "agent-notification") {
    attributes.push(["source-agent-id", source.agentId]);
    if (source.serverId) attributes.push(["source-server-id", source.serverId]);
    if (source.title) attributes.push(["source-agent-title", source.title]);
  }
  if (source?.kind === "agent-notification") attributes.push(["event", source.event]);
  if (source?.kind === "change-request-update") attributes.push(["source-url", source.url]);
  attributes.push(["length", String(message.text.length)]);
  return attributes;
}

export function formatAgentMessage(message: AgentMessage): string {
  // Providers trim a user prompt when they replay history, so the body never starts with
  // whitespace; otherwise the replayed body would fall short of `length`.
  const text = message.text.trimStart();
  const attributes = markerAttributes({ ...message, text })
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join("");
  return `${text}\n\n<paseo-message${attributes}/>`;
}

function parseAttributes(raw: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  for (const match of raw.matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = unescapeXml(match[2]);
    if (value === null || attributes.has(match[1])) return null;
    attributes.set(match[1], value);
  }
  return attributes;
}

function toMessage(attributes: Map<string, string>, text: string): AgentMessage | null {
  const id = attributes.get("message-id");
  if (!id) return null;
  if (attributes.get("kind") === "user-message") {
    if (attributes.has("source-agent-id") || attributes.has("event")) return null;
    return { id, source: null, text };
  }
  const source = markedSourceSchema.safeParse({
    kind: attributes.get("kind"),
    agentId: attributes.get("source-agent-id"),
    serverId: attributes.get("source-server-id"),
    event: attributes.get("event"),
    title: attributes.get("source-agent-title"),
    url: attributes.get("source-url"),
  });
  return source.success ? { id, source: source.data, text } : null;
}

/** Reads markers from the end; each one claims the `length` characters before it. */
function parseMarkedMessages(text: string): AgentMessage[] | null {
  const messages: AgentMessage[] = [];
  let rest = text.replace(/\n+$/, "");
  while (rest) {
    const markerStart = rest.lastIndexOf(MARKER_START);
    if (markerStart < 0) return null;
    const marker = MARKER_PATTERN.exec(rest.slice(markerStart + 2));
    const attributes = marker ? parseAttributes(marker[1]) : null;
    const length = attributes?.get("length");
    if (!attributes || !length || !/^\d+$/.test(length)) return null;
    const bodyStart = markerStart - Number(length);
    if (bodyStart < 0) return null;
    const message = toMessage(attributes, rest.slice(bodyStart, markerStart));
    if (!message) return null;
    messages.unshift(message);
    rest = rest.slice(0, bodyStart);
    // Providers replay the joined text blocks of a batch with one or two newlines between them.
    const previous = rest.replace(/\n+$/, "");
    if (previous === rest && rest) return null;
    rest = previous;
  }
  return messages.length ? messages : null;
}

// COMPAT(leadingPaseoSystemEnvelope): added in v0.18.1, remove after 2027-11-28. Provider
// transcripts written before trailing markers open with a <paseo-system> envelope.
const LEGACY_ENVELOPE = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/;
const LEGACY_SCHEDULE_ENVELOPE = /^<paseo-system>\n([\s\S]*)\n<\/paseo-system>$/;

function parseLegacyEnvelope(text: string): AgentMessage | null {
  const envelope = LEGACY_ENVELOPE.exec(text);
  const attributes = envelope ? parseAttributes(envelope[1]) : null;
  if (!envelope || !attributes || attributes.get("version") !== "1") return null;
  const body = unescapeXml(envelope[2]);
  if (body === null) return null;
  // #10864 sent a child's interim "ended its turn" notice with the neutral "message" event,
  // which clients showed as a message from the child.
  if (attributes.get("kind") === "agent-notification" && attributes.get("event") === "message")
    attributes.set("kind", "agent-message");
  return toMessage(attributes, body);
}

function parseLegacyEnvelopes(text: string): AgentMessage[] | null {
  const schedule = LEGACY_SCHEDULE_ENVELOPE.exec(text);
  if (schedule) {
    // Schedule bodies include the run ID, keeping identity stable across replay.
    const id = createHash("sha256").update(text).digest("hex");
    return [{ id, source: { kind: "schedule" }, text: schedule[1] }];
  }
  // Bodies are XML escaped, so a literal closing tag unambiguously ends an entry.
  const messages = text
    .split(/(?<=<\/paseo-system>)\n+(?=<paseo-system )/)
    .map(parseLegacyEnvelope);
  return messages.every((message) => message !== null) ? messages : null;
}

/** Accept only text made entirely of marked messages; prose around them stays user text. */
export function parseAgentMessages(text: string): AgentMessage[] | null {
  return parseMarkedMessages(text) ?? parseLegacyEnvelopes(text);
}

export function parseAgentMessage(text: string): AgentMessage | null {
  const messages = parseAgentMessages(text);
  return messages?.length === 1 ? messages[0]! : null;
}

function renderMessageText(block: AgentPromptContentBlock): string[] {
  if (block.type === "image") return [];
  if (block.type === "text") return [block.text];
  return [renderPromptAttachmentAsText(block)];
}

export function prepareAgentMessage(
  prompt: AgentPromptInput,
  source?: AgentPromptSource,
  id?: string,
): { prompt: AgentPromptInput; messageId?: string } {
  if (!source) {
    const submittedText =
      typeof prompt === "string"
        ? prompt
        : prompt
            .flatMap((block) =>
              block.type === "text" && !("mimeType" in block) ? [block.text] : [],
            )
            .join("\n");
    // Mark reserved syntax only when it arrived through the human send path. This provenance
    // must survive provider history, not only the accepted local row.
    if (!RESERVED_SYNTAX.test(submittedText)) return { prompt, messageId: id };
  }
  return envelopeMessage(prompt, source ?? null, id);
}

/**
 * Mark a prompt unconditionally. A person's prompt (`source` null) needs a marker only when it
 * contains marker syntax or shares a provider prompt with agent messages.
 */
export function envelopeMessage(
  prompt: AgentPromptInput,
  source: AgentPromptSource | null,
  id?: string,
): { prompt: AgentPromptInput; messageId: string } {
  const messageId = id ?? randomUUID();
  const text = typeof prompt === "string" ? prompt : prompt.flatMap(renderMessageText).join("\n\n");
  // Render textual attachments before marking, so provider replay still contains one
  // complete marked message instead of one followed by provider-rendered context.
  const marked = formatAgentMessage({ id: messageId, source, text });
  return {
    messageId,
    prompt:
      typeof prompt === "string"
        ? marked
        : [{ type: "text", text: marked }, ...prompt.filter((block) => block.type === "image")],
  };
}

/** The same projection owns provider echoes, acceptance, import, and replay. */
export function projectAgentMessages(item: AgentTimelineItem): AgentTimelineItem[] {
  if (item.type !== "user_message") return [item];
  const messages = parseAgentMessages(item.text);
  return messages ? messages.map((message) => projectAgentMessage(item, message)) : [item];
}

/**
 * The daemon decides how each delivered message reads: a person's text and peer messages are
 * messages, and everything the daemon reports is a completed plain-text tool call.
 */
function projectAgentMessage(
  item: Extract<AgentTimelineItem, { type: "user_message" }>,
  message: AgentMessage,
): AgentTimelineItem {
  const { source } = message;
  if (!source) return { ...item, text: message.text, clientMessageId: message.id };
  switch (source.kind) {
    case "schedule":
      return {
        type: "tool_call",
        callId: `paseo-system:${message.id}`,
        name: "heartbeat",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: message.text, icon: "sparkles" },
      };
    case "change-request-update":
      return {
        type: "tool_call",
        callId: `paseo-change-request:${message.id}`,
        name: "change_request_update",
        status: "completed",
        error: null,
        detail: { type: "plain_text", label: source.url, text: message.text },
      };
    case "agent-notification":
      return {
        type: "tool_call",
        callId: `paseo-agent-message:${message.id}`,
        name: NOTIFICATION_TOOL_NAMES[source.event],
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          label: source.title ?? source.agentId,
          text: message.text,
          icon: "bot",
        },
      };
    case "agent-message":
      return {
        type: "tool_call",
        callId: `paseo-agent-message:${message.id}`,
        // The wire has no sender on a user message, so clients render this as a "Sent by"
        // bubble. Older clients that predate the bubble expand the plain-text body.
        agentMessage: {
          event: "message",
          sender: {
            id: source.agentId,
            ...(source.serverId ? { serverId: source.serverId } : {}),
            ...(source.title ? { title: source.title } : {}),
          },
          text: message.text,
        },
        name: "agent_message",
        status: "completed",
        error: null,
        detail: { type: "plain_text", text: message.text, icon: "bot" },
      };
  }
}

/** Mark a schedule fire so the receiving agent reads it as daemon context, not a user turn. */
export function formatSystemNotificationPrompt(body: string): string {
  return formatAgentMessage({ id: randomUUID(), source: { kind: "schedule" }, text: body });
}
