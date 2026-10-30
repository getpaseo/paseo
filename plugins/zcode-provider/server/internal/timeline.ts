import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { ZCodeEvent } from "./transport.js";

interface EventPayload {
  messageId?: string;
  partId?: string;
  field?: string;
  delta?: string;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  kind?: string;
  input?: unknown;
  error?: { message?: string };
}

export interface TimelineMappingOptions {
  /**
   * The detail of each tool call, keyed by tool call id. ZCode carries a
   * tool call's input only on the `scheduled` variant, so the detail has to
   * survive from that event to the `result` and `error` variants.
   */
  toolDetails?: ReadonlyMap<string, ProviderToolCallDetail>;
}

export function mapEventToTimelineItems(
  event: ZCodeEvent,
  options: TimelineMappingOptions = {},
): ProviderTimelineItem[] {
  const payload = (event.payload ?? {}) as EventPayload;
  if (event.type === "message.upserted") {
    // ZCode's message payload carries the content and nothing else: no
    // message id and no role. The id comes from the event, and a user
    // message cannot be told apart from an assistant one here.
    const id = `${event.sessionId}-${event.seq}`;
    return [{ id, type: "assistant_message", text: payload.content ?? "" }];
  }
  if (event.type === "part.delta") {
    const id = payload.partId ?? payload.messageId ?? `${event.sessionId}-${event.seq}`;
    const text = payload.delta ?? "";
    if (payload.field === "reasoning") return [{ id, type: "reasoning", text }];
    return [{ id, type: "assistant_message", text }];
  }
  if (event.type === "tool.updated") {
    return mapToolCall(event, payload, options);
  }
  return [];
}

/**
 * A tool call's detail, status and error. Kept apart from the event switch
 * so each mapper stays under the complexity the linter allows.
 */
function mapToolCall(
  event: ZCodeEvent,
  payload: EventPayload,
  options: TimelineMappingOptions,
): ProviderTimelineItem[] {
  const callId = payload.toolCallId ?? `${event.sessionId}-${event.seq}`;
  const name = payload.toolName ?? "tool";
  const detail = options.toolDetails?.get(callId) ??
    (payload.kind === "scheduled" ? toolDetailFor(payload.input) : undefined) ?? {
      type: "plain_text",
      label: name,
      text: "",
    };
  // A tool call is a discriminated union: `error` is null for every status
  // except `failed`. Compute the status and the error together, or the
  // object literal satisfies neither branch.
  if (payload.kind === "error") {
    return [
      {
        id: callId,
        type: "tool_call",
        callId,
        name,
        status: "failed",
        error: { message: payload.error?.message ?? "tool failed" },
        detail,
      },
    ];
  }
  const status = payload.kind === "result" ? "completed" : "running";
  return [{ id: callId, type: "tool_call", callId, name, status, error: null, detail }];
}

/**
 * ZCode reports a tool call as a name and an opaque input object. Pick the
 * detail variant that matches the input, so the client renders a file read
 * as a file read instead of a shell command.
 */
export function toolDetailFor(input: unknown): ProviderToolCallDetail {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const command = record.command;
  if (typeof command === "string") return { type: "shell", command };
  const filePath = record.filePath ?? record.path;
  if (typeof filePath === "string") return { type: "read", filePath };
  const query = record.query;
  if (typeof query === "string") return { type: "search", query };
  return { type: "shell", command: "" };
}
