import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import {
  parseJsonRecord,
  readNumber,
  readString,
  type MuseViewItem,
} from "./items.js";

export type MuseToolCallStatus = "running" | "completed" | "failed" | "canceled";

export function mapMuseToolStatus(status: unknown): MuseToolCallStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "rejected":
    case "timedOut":
      return "failed";
    case "cancelled":
      return "canceled";
    case "inProgress":
    default:
      return "running";
  }
}

function readCommandText(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) {
    return undefined;
  }
  const direct = readString(args, ["command", "cmd", "commandText"]);
  if (direct) {
    return direct;
  }
  const argv = args["args"];
  if (Array.isArray(argv) && argv.every((entry): entry is string => typeof entry === "string")) {
    const joined = argv.join(" ").trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

function buildShellDetail(
  item: MuseViewItem,
  args: Record<string, unknown> | undefined,
  output: string | undefined,
): ToolCallDetail {
  return {
    type: "shell",
    command:
      (typeof item.commandText === "string" && item.commandText) ||
      readCommandText(args) ||
      (typeof item.tool === "string" ? item.tool : "shell"),
    cwd: args ? readString(args, ["cwd", "workdir", "workingDirectory"]) : undefined,
    output,
    exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
  };
}

export function mapMuseToolDetail(item: MuseViewItem): ToolCallDetail {
  const toolName = typeof item.tool === "string" ? item.tool : "";
  const output =
    typeof item.visibleOutput === "string" && item.visibleOutput.length > 0
      ? item.visibleOutput
      : undefined;
  const args = parseJsonRecord(item.args);
  const filePath = args ? readString(args, ["path", "filePath", "file", "filename"]) : undefined;
  const name = toolName.toLowerCase();

  if (
    name.includes("shell") ||
    name.includes("exec") ||
    name.includes("bash") ||
    name.includes("command") ||
    name.includes("terminal") ||
    item.commandText !== undefined
  ) {
    return buildShellDetail(item, args, output);
  }
  if (name.includes("read") && filePath) {
    return {
      type: "read",
      filePath,
      content: output,
      offset: args ? readNumber(args, ["offset", "line", "startLine"]) : undefined,
      limit: args ? readNumber(args, ["limit", "numLines", "lineCount"]) : undefined,
    };
  }
  if (
    (name.includes("edit") || name.includes("apply_patch") || name.includes("patch")) &&
    filePath
  ) {
    const diffSummary =
      typeof item.patchSummary === "string" && item.patchSummary.length > 0
        ? item.patchSummary
        : undefined;
    return {
      type: "edit",
      filePath,
      oldString: args ? readString(args, ["oldText", "oldString", "original"]) : undefined,
      newString: args ? readString(args, ["newText", "newString", "updated"]) : undefined,
      unifiedDiff: diffSummary ?? output,
    };
  }
  if ((name.includes("write") || name.includes("create")) && filePath) {
    return {
      type: "write",
      filePath,
      content:
        (args ? readString(args, ["content", "text", "data"]) : undefined) ?? output,
    };
  }
  if (output) {
    return {
      type: "plain_text",
      label: toolName || "tool",
      text: output,
      icon: "wrench",
    };
  }
  return {
    type: "unknown",
    input: args ?? item.args ?? null,
    output: null,
  };
}

export function mapMuseToolCall(item: MuseViewItem): ToolCallTimelineItem {
  const status = mapMuseToolStatus(item.status);
  const callId =
    typeof item.callId === "string" && item.callId.length > 0 ? item.callId : item.itemId;
  const base = {
    type: "tool_call" as const,
    callId,
    name: typeof item.tool === "string" && item.tool.length > 0 ? item.tool : "tool",
    detail: mapMuseToolDetail(item),
  };
  if (status === "failed") {
    const reason =
      typeof item.failureReason === "string" && item.failureReason.length > 0
        ? item.failureReason
        : "Muse tool call failed";
    return { ...base, status: "failed", error: { message: reason } };
  }
  if (status === "completed") {
    return { ...base, status: "completed", error: null };
  }
  if (status === "canceled") {
    return { ...base, status: "canceled", error: null };
  }
  return { ...base, status: "running", error: null };
}
