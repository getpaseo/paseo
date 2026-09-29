import { MspConnection } from "./connection.js";
import { MuseError } from "./errors.js";
import { todoSchema, outputSchema } from "./wire.js";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { z } from "zod";
import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { patchSchema, toolArgsSchema, deltaSchema, type WireItem } from "./wire.js";

export function unifiedDiff(content: string): string {
  const patch = patchSchema.parse(JSON.parse(content));
  return patch.files
    .map((file) => {
      const hunks = file.hunks.map(
        (hunk) =>
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`,
      );
      return `--- a/${file.path}\n+++ b/${file.path}\n${hunks.join("")}`;
    })
    .join("");
}

function toolDetail(item: WireItem, patch?: string): ProviderToolCallDetail {
  const parsed = toolArgsSchema.safeParse(parseArguments(item.args));
  if (!parsed.success) return { type: "unknown", input: item.args, output: item.visibleOutput };
  const args = parsed.data;
  switch (item.tool) {
    case "workflow":
    case "subagent_spawn":
    case "subagent_wait":
    case "subagent_read_result":
      return subAgentDetail(item, args);
    case "shell":
    case "bash":
      return {
        type: "shell",
        command: item.commandText ?? args.command,
        output: item.visibleOutput,
        exitCode: item.exitCode,
      };
    case "read_file":
      return { type: "read", filePath: args.path, content: item.visibleOutput };
    case "edit_file":
      return {
        type: "edit",
        filePath: args.path,
        oldString: args.find,
        newString: args.replace,
        unifiedDiff: patch,
      };
    case "write_file":
      return { type: "write", filePath: args.path, content: args.content };
    case "grep":
    case "glob":
    case "ls":
    case "web_search":
      return {
        type: "search",
        query: args.query || args.pattern || args.path,
        content: item.visibleOutput,
      };
    case "web_fetch":
      return { type: "fetch", url: args.url, result: item.visibleOutput };
    default:
      return { type: "unknown", input: item.args, output: item.visibleOutput };
  }
}
function subAgentDetail(
  item: WireItem,
  args: z.infer<typeof toolArgsSchema>,
): ProviderToolCallDetail {
  return {
    type: "sub_agent",
    description: item.objective ?? item.entryId ?? args.objective,
    subAgentType: item.role ?? args.role,
    childSessionId: item.childSessionId,
    log: item.message || item.visibleOutput || item.fallbackText,
  };
}

function parseArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

export function timelineItem(
  item: WireItem,
  clientMessageId?: string,
  patch?: string,
): ProviderTimelineItem {
  const id = item.itemId;
  switch (item.kind) {
    case "userMessage":
      return { type: "user_message", id, text: item.displayText ?? item.text, clientMessageId };
    case "agentMessage":
      return { type: "assistant_message", id, text: item.text };
    case "reasoning":
      return { type: "reasoning", id, text: item.summary.join("\n") };
    case "compaction":
      return {
        type: "compaction",
        id,
        status: item.status === "inProgress" ? "loading" : "completed",
        preTokens: item.tokensBefore,
      };
    case "workflow":
    case "subagent":
    case "toolCall": {
      return toolCallItem(item, patch);
    }
    default:
      return {
        type: "tool_call",
        id,
        callId: id,
        name: item.kind,
        status: "completed",
        error: null,
        detail: { type: "plain_text", label: item.kind, text: item.fallbackText },
      };
  }
}

function toolCallItem(item: WireItem, patch?: string): ProviderTimelineItem {
  const id = item.itemId;
  const base = {
    type: "tool_call",
    id,
    callId: item.callId ?? id,
    name: item.kind === "toolCall" ? item.tool : item.kind,
    detail:
      item.kind === "subagent" || item.kind === "workflow"
        ? {
            type: "sub_agent" as const,
            subAgentType: item.role,
            description: item.objective ?? item.entryId,
            childSessionId: item.childSessionId,
            log: item.message || item.visibleOutput || item.fallbackText,
          }
        : toolDetail(item, patch),
  } as const;
  if (item.status === "inProgress") return { ...base, status: "running", error: null };
  if (item.status === "cancelled") return { ...base, status: "canceled", error: null };
  if (item.status !== "completed")
    return { ...base, status: "failed", error: item.failureReason ?? item.status };
  return { ...base, status: "completed", error: null };
}

export function appendDelta(
  previous: WireItem,
  delta: z.infer<typeof deltaSchema>,
): WireItem | null {
  if (delta.field === "text") return { ...previous, text: previous.text + delta.delta };
  if (delta.field === "output")
    return { ...previous, visibleOutput: previous.visibleOutput + delta.delta };
  const match = /^summary\.(\d+)$/.exec(delta.field);
  if (!match) return null;
  const index = Number(match[1]);
  const summary = [...previous.summary];
  summary[index] = (summary[index] ?? "") + delta.delta;
  return { ...previous, summary };
}

export class Timeline {
  private readonly items = new Map<string, WireItem>();
  constructor(
    private readonly host: MspConnection,
    private readonly nativeId: string,
    private readonly id: string,
    private readonly emit: (event: ProviderEvent) => void,
    private readonly clientMessage: (commandId: string) => string | undefined = () => undefined,
  ) {}
  async fold(item: WireItem): Promise<boolean> {
    const previous = this.items.get(item.itemId);
    if (previous && previous.revision >= item.revision) return false;
    let patch;
    if (item.patchRef && item.status === "completed") {
      const output = await this.host.request(
        "item/readOutput",
        { sessionId: this.nativeId, itemId: item.itemId, outputRef: item.patchRef.id },
        outputSchema,
      );
      if (output.encoding !== "utf8" || !output.eof)
        throw new MuseError("invalidPatch", "Muse edit patch is not a complete UTF-8 document");
      patch = unifiedDiff(output.content);
    }
    this.items.set(item.itemId, item);
    this.emit({
      type: "timeline.item",
      sessionId: this.id,
      item: timelineItem(
        item,
        item.commandId ? this.clientMessage(item.commandId) : undefined,
        patch,
      ),
      timestamp: item.recordedAt,
    });
    return true;
  }
  delta(delta: z.infer<typeof deltaSchema>): void {
    const previous = this.items.get(delta.itemId);
    if (!previous || previous.status !== "inProgress") return;
    const item = appendDelta(previous, delta);
    if (!item) return;
    this.items.set(item.itemId, item);
    this.emit({ type: "timeline.item", sessionId: this.id, item: timelineItem(item) });
  }
}

export function todoItem(input: unknown): ProviderTimelineItem {
  const todo = todoSchema.parse(input);
  return {
    type: "todo",
    id: `todo:${todo.viewCursor}`,
    items: todo.items.map((item) => {
      let status: "pending" | "in_progress" | "completed" = "pending";
      if (item.status === "inProgress") status = "in_progress";
      else if (item.status === "completed") status = "completed";
      return {
        text: item.text,
        completed: item.status === "completed",
        status,
        activeForm: item.activeForm,
      };
    }),
  };
}
