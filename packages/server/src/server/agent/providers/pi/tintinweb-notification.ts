import type { PiAgentMessage } from "./rpc-types.js";

type PiCustomMessage = Extract<PiAgentMessage, { role: "custom" }>;

const TINTINWEB_NOTIFICATION_TYPE = "subagent-notification";
const TASK_NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g;

interface NotificationPresentation {
  heading: string;
  result: string | null;
  error: string | null;
  turnCount: number | null;
  maxTurns: number | null;
  toolUses: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  outputFile: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function statusPhrase(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    case "aborted":
      return "stopped at turn limit";
    case "steered":
      return "completed at turn limit";
    case "stopped":
      return "stopped";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return `finished (${status.trim()})`;
  }
}

function parseDetailsEntry(value: unknown): NotificationPresentation | null {
  const details = asRecord(value);
  if (!details) {
    return null;
  }
  const description = optionalString(details.description);
  const status = optionalString(details.status);
  if (!description || !status) {
    return null;
  }
  return {
    heading: `Agent ${statusPhrase(status)}: ${description}`,
    result: optionalString(details.resultPreview),
    error: optionalString(details.error),
    turnCount: optionalCount(details.turnCount),
    maxTurns: optionalCount(details.maxTurns),
    toolUses: optionalCount(details.toolUses),
    totalTokens: optionalCount(details.totalTokens),
    durationMs: optionalCount(details.durationMs),
    outputFile: optionalString(details.outputFile),
  };
}

function parseDetails(value: unknown): NotificationPresentation[] {
  const details = asRecord(value);
  if (!details) {
    return [];
  }
  const first = parseDetailsEntry(details);
  if (!first) {
    return [];
  }
  const others = Array.isArray(details.others)
    ? details.others.flatMap((entry) => {
        const parsed = parseDetailsEntry(entry);
        return parsed ? [parsed] : [];
      })
    : [];
  return [first, ...others];
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function readXmlTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? optionalString(decodeXmlText(match[1])) : null;
}

function readXmlCount(block: string, tag: string): number | null {
  const value = readXmlTag(block, tag);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function parseXml(content: string): NotificationPresentation[] {
  return Array.from(content.matchAll(TASK_NOTIFICATION_PATTERN)).flatMap((match) => {
    const block = match[1];
    const summary = readXmlTag(block, "summary");
    if (!summary) {
      return [];
    }
    return [
      {
        heading: summary,
        result: readXmlTag(block, "result"),
        error: null,
        turnCount: null,
        maxTurns: null,
        toolUses: readXmlCount(block, "tool_uses"),
        totalTokens: readXmlCount(block, "total_tokens"),
        durationMs: readXmlCount(block, "duration_ms"),
        outputFile: readXmlTag(block, "output-file"),
      },
    ];
  });
}

function messageText(message: PiCustomMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n\n");
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M tokens`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k tokens`;
  }
  return `${count} token${count === 1 ? "" : "s"}`;
}

function formatStats(notification: NotificationPresentation): string | null {
  const stats: string[] = [];
  if (notification.turnCount && notification.turnCount > 0) {
    const count = notification.maxTurns
      ? `${notification.turnCount}/${notification.maxTurns}`
      : String(notification.turnCount);
    stats.push(`${count} turn${notification.turnCount === 1 ? "" : "s"}`);
  }
  if (notification.toolUses && notification.toolUses > 0) {
    stats.push(`${notification.toolUses} tool use${notification.toolUses === 1 ? "" : "s"}`);
  }
  if (notification.totalTokens && notification.totalTokens > 0) {
    stats.push(formatTokens(notification.totalTokens));
  }
  if (notification.durationMs && notification.durationMs > 0) {
    stats.push(`${(notification.durationMs / 1000).toFixed(1)}s`);
  }
  return stats.length > 0 ? stats.join(" | ") : null;
}

function formatNotification(notification: NotificationPresentation): string {
  const lines = [`**${notification.heading}**`];
  const stats = formatStats(notification);
  if (stats) {
    lines.push(stats);
  }
  if (notification.error) {
    lines.push("", `Error: ${notification.error}`);
  }
  if (notification.result && notification.result !== "No output.") {
    lines.push("", notification.result);
  }
  if (notification.outputFile) {
    lines.push("", `Transcript: \`${notification.outputFile}\``);
  }
  return lines.join("\n");
}

export function formatTintinwebSubagentNotification(message: PiCustomMessage): string | null {
  if (message.customType !== TINTINWEB_NOTIFICATION_TYPE) {
    return null;
  }
  const content = messageText(message);
  const notifications = parseDetails(message.details);
  const parsed = notifications.length > 0 ? notifications : parseXml(content);
  if (parsed.length === 0) {
    return null;
  }
  const isGroup = content.startsWith("Background agent group completed:");
  const isPartialGroup = isGroup && content.split("\n", 1)[0]?.includes("partial");
  const parts = [parsed.map(formatNotification).join("\n\n---\n\n")];
  if (isGroup || parsed.length > 1) {
    const qualifier = isPartialGroup ? " (other agents still running)" : "";
    parts.unshift(`**Background agent results${qualifier}**`);
  }
  if (content.includes("Use get_subagent_result for full output.")) {
    parts.push("Use `get_subagent_result` for full output.");
  }
  return parts.join("\n\n");
}
