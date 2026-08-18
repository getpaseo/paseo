import { createHash } from "node:crypto";

import type { ToolCallTimelineItem } from "../../agent-sdk-types.js";
import type { PiAgentMessage } from "./rpc-types.js";

const IRC_ENVELOPE_PATTERN =
  /^<irc>\r?\nIncoming IRC message from agent (?:`([^`\r\n]+)`|([A-Za-z0-9][A-Za-z0-9._/@-]*))(?: \(reply to [^)\r\n]+\))?:\r?\n\r?\n([\s\S]*?)\r?\n\r?\n(?:Sent while waiting\/working\.|An agent sent this while you were waiting or working\.)[\s\S]*\r?\n<\/irc>$/;

interface ParsedIrcMessage {
  sender: string;
  text: string;
  id?: string;
}

function parseStructuredDetails(details: unknown): ParsedIrcMessage | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return null;
  }
  const from = Reflect.get(details, "from");
  const message = Reflect.get(details, "message");
  if (typeof from !== "string" || !from.trim() || typeof message !== "string") {
    return null;
  }
  const id = Reflect.get(details, "id");
  return {
    sender: from.trim(),
    text: message,
    ...(typeof id === "string" && id.trim() ? { id: id.trim() } : {}),
  };
}

export function parsePiIrcEnvelope(rawText: string): ParsedIrcMessage | null {
  const match = IRC_ENVELOPE_PATTERN.exec(rawText);
  if (!match) {
    return null;
  }
  const sender = (match[1] ?? match[2] ?? "").trim();
  const text = match[3];
  if (!sender || text === undefined || !text.trim()) {
    return null;
  }
  return { sender, text };
}

export function mapPiIrcMessage(
  message: Extract<PiAgentMessage, { role: "custom" }>,
  rawText: string,
): ToolCallTimelineItem | null {
  if (message.customType !== "irc:incoming") {
    return null;
  }
  const structured = parseStructuredDetails(message.details);
  const parsed = structured ?? parsePiIrcEnvelope(rawText);
  if (!parsed) {
    return null;
  }
  const callId = structured?.id
    ? `pi-irc:${structured.id}`
    : `pi-irc:${createHash("sha256").update(rawText).digest("hex")}`;
  return {
    type: "tool_call",
    callId,
    name: "agent_message",
    status: "completed",
    detail: {
      type: "sub_agent",
      subAgentType: parsed.sender,
      description: parsed.text,
      log: rawText,
    },
    error: null,
  };
}
