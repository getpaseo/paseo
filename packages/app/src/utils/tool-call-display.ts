import { z } from "zod";

import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";

export type ToolCallKind =
  | "read"
  | "edit"
  | "write"
  | "execute"
  | "search"
  | "agent"
  | "tool"
  | "thinking";

type SummaryParams = {
  name: string;
  detail?: ToolCallDetail;
  metadata?: Record<string, unknown>;
  cwd?: string;
};

export type ToolCallDisplayModel = {
  kind: ToolCallKind;
  displayName: string;
  summary?: string;
};

const TOOL_CALL_DETAIL_SCHEMA: z.ZodType<ToolCallDetail> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("shell"),
    command: z.string(),
    cwd: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().nullable().optional(),
  }),
  z.object({
    type: z.literal("read"),
    filePath: z.string(),
    content: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  z.object({
    type: z.literal("edit"),
    filePath: z.string(),
    oldString: z.string().optional(),
    newString: z.string().optional(),
    unifiedDiff: z.string().optional(),
  }),
  z.object({
    type: z.literal("write"),
    filePath: z.string(),
    content: z.string().optional(),
  }),
  z.object({
    type: z.literal("search"),
    query: z.string(),
  }),
]);

const TOOL_CALL_DISPLAY_INPUT_SCHEMA = z.object({
  name: z.string().min(1),
  detail: TOOL_CALL_DETAIL_SCHEMA.optional(),
  metadata: z.record(z.unknown()).optional(),
  cwd: z.string().optional(),
});

function toTitleCase(words: string): string {
  return words
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return name;
  }
  return toTitleCase(trimmed.replace(/[._-]+/g, " "));
}

export function stripCwdPrefix(filePath: string, cwd?: string): string {
  if (!cwd || !filePath) return filePath;

  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = filePath.replace(/\\/g, "/");

  const prefix = `${normalizedCwd}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }
  if (normalizedPath === normalizedCwd) {
    return ".";
  }
  return filePath;
}

function buildDisplayFromDetail(detail: ToolCallDetail, cwd?: string): ToolCallDisplayModel {
  switch (detail.type) {
    case "shell":
      return {
        kind: "execute",
        displayName: "Shell",
        summary: detail.command,
      };
    case "read":
      return {
        kind: "read",
        displayName: "Read",
        summary: stripCwdPrefix(detail.filePath, cwd),
      };
    case "edit":
      return {
        kind: "edit",
        displayName: "Edit",
        summary: stripCwdPrefix(detail.filePath, cwd),
      };
    case "write":
      return {
        kind: "write",
        displayName: "Write",
        summary: stripCwdPrefix(detail.filePath, cwd),
      };
    case "search":
      return {
        kind: "search",
        displayName: "Search",
        summary: detail.query,
      };
    default:
      return {
        kind: "tool",
        displayName: "Tool",
      };
  }
}

function buildDisplayWithoutDetail(params: {
  toolNameLower: string;
  rawName: string;
  metadata?: Record<string, unknown>;
}): ToolCallDisplayModel {
  if (params.toolNameLower === "task") {
    const summary = params.metadata?.subAgentActivity;
    return {
      kind: "agent",
      displayName: "Task",
      summary: typeof summary === "string" && summary.trim().length > 0 ? summary : undefined,
    };
  }

  if (params.toolNameLower === "thinking") {
    return {
      kind: "thinking",
      displayName: "Thinking",
    };
  }

  return {
    kind: "tool",
    displayName: humanizeToolName(params.rawName),
  };
}

export function buildToolCallDisplayModel(params: SummaryParams): ToolCallDisplayModel {
  const parsed = TOOL_CALL_DISPLAY_INPUT_SCHEMA.parse(params);
  if (parsed.detail) {
    return buildDisplayFromDetail(parsed.detail, parsed.cwd);
  }

  return buildDisplayWithoutDetail({
    toolNameLower: parsed.name.trim().toLowerCase(),
    rawName: parsed.name,
    metadata: parsed.metadata,
  });
}

export function resolveToolCallDisplayName(name: string, detail?: ToolCallDetail): string {
  return buildToolCallDisplayModel({ name, detail }).displayName;
}

export function resolveToolCallKind(name: string, detail?: ToolCallDetail): ToolCallKind {
  return buildToolCallDisplayModel({ name, detail }).kind;
}

export function resolveToolCallSummary(params: SummaryParams): string | undefined {
  return buildToolCallDisplayModel(params).summary;
}

export function formatToolCallError(error: unknown): string | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    "content" in (error as Record<string, unknown>) &&
    typeof (error as Record<string, unknown>).content === "string"
  ) {
    return (error as Record<string, unknown>).content as string;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}
