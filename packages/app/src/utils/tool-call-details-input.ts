import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

export function deriveFallbackToolCallInput(detail: ToolCallDetail | undefined): unknown {
  if (!detail) return undefined;

  switch (detail.type) {
    case "read":
      return compactInput({ path: detail.filePath, offset: detail.offset, limit: detail.limit });
    case "edit":
    case "write":
      return compactInput({ path: detail.filePath });
    case "search":
      return compactInput({ query: detail.query });
    case "fetch":
      return compactInput({ url: detail.url, prompt: detail.prompt });
    default:
      return undefined;
  }
}

function compactInput(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined && value !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
