import type { TimelineItem } from "./types";

export type PeekRole = "you" | "agent" | "tool" | "thinking" | "system";

export interface PeekRow {
  role: PeekRole;
  text: string;
}

export function firstLine(text: string, max = 160): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function toolSuffix(status: string): string {
  if (status === "running") return "…";
  if (status === "failed") return " (failed)";
  return "";
}

/** One line per canonical row. Returns null for rows the peek does not show. */
export function itemToPeekRow(item: TimelineItem): PeekRow | null {
  switch (item.type) {
    case "user_message":
      return { role: "you", text: item.text.trim() };
    case "assistant_message":
      return { role: "agent", text: item.text.trim() };
    case "reasoning":
      return { role: "thinking", text: firstLine(item.text) };
    case "tool_call":
      return { role: "tool", text: `${item.name}${toolSuffix(item.status)}` };
    case "error":
      return { role: "system", text: item.message };
    case "notification":
      return { role: "system", text: item.message };
    default:
      return null;
  }
}

export function lastAssistantLine(items: readonly TimelineItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "assistant_message") {
      const line = firstLine(item.text);
      if (line) return line;
    }
  }
  return null;
}
