import type { PermissionRequest, TimelineItem } from "./types";

type ToolDetail = NonNullable<PermissionRequest["detail"]>;
type ToolCallItem = Extract<TimelineItem, { type: "tool_call" }>;

export interface ToolText {
  /** Short label: the tool name, plus the file name for file tools. */
  headline: string;
  /** One line of what the tool targets: command, path, query, or URL. */
  preview: string | null;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function oneLine(text: string | undefined | null): string | null {
  if (!text) return null;
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
}

function readString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Describes a tool call detail the way the timeline's collapsed row does, as text. */
export function describeDetail(
  name: string,
  detail: ToolDetail | undefined,
  input?: Record<string, unknown>,
): ToolText {
  switch (detail?.type) {
    case "shell":
      return { headline: name, preview: oneLine(detail.command) };
    case "read":
    case "edit":
    case "write":
      return { headline: `${name} ${baseName(detail.filePath)}`, preview: detail.filePath };
    case "search":
      return { headline: name, preview: detail.query };
    case "fetch":
      return { headline: name, preview: detail.url };
    case "sub_agent":
      return { headline: name, preview: oneLine(detail.description) };
    case "plain_text":
      return { headline: detail.label ?? name, preview: oneLine(detail.text) };
    case "plan":
      return { headline: name, preview: oneLine(detail.text) };
    default: {
      const path = readString(input, ["file_path", "filePath", "path", "notebook_path"]);
      if (path) return { headline: `${name} ${baseName(path)}`, preview: path };
      const preview = readString(input, [
        "command",
        "pattern",
        "query",
        "url",
        "description",
        "prompt",
      ]);
      return { headline: name, preview };
    }
  }
}

export function describeRequest(request: PermissionRequest): ToolText {
  const name = request.title ?? request.name;
  const text = describeDetail(name, request.detail, request.input);
  return { headline: text.headline, preview: request.description ?? text.preview };
}

export function describeToolCall(item: ToolCallItem): string {
  const text = describeDetail(item.name, item.detail);
  const suffix = item.status === "failed" ? " (failed)" : "";
  return text.preview ? `${text.headline}: ${text.preview}${suffix}` : `${text.headline}${suffix}`;
}

export function lastToolCall(items: readonly TimelineItem[]): ToolCallItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "tool_call") return item;
  }
  return null;
}
