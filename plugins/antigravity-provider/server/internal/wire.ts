import { z } from "zod";

const usage = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  cache_read_tokens: z.number().nonnegative().default(0),
});
const tool = z.object({
  name: z.string(),
  parameters: z.record(z.string(), z.json()).default({}),
  output: z.string().default(""),
  error: z.object({ type: z.string(), message: z.string() }).nullable().default(null),
});
const child = z.object({
  type_name: z.string(),
  role: z.string().default(""),
  initial_prompt: z.string().default(""),
  conversation_id: z.string().nullable().default(null),
  log_uri: z.string().default(""),
  workspace_uris: z.array(z.string()).default([]),
});
const frame = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("init"),
    conversation_id: z.string().min(1),
    init: z.object({ model: z.string().nullable().default(null) }),
  }),
  z.object({
    event: z.literal("step_update"),
    step_update: z.object({
      conversation_id: z.string(),
      step_index: z.number().int().nonnegative(),
      state: z.enum(["ACTIVE", "DONE", "ERROR"]),
      step_type: z.string(),
      text_delta: z.string().default(""),
      tool_name: z.string().default(""),
      tool_info: tool.nullable().default(null),
      subagent_info: z
        .object({ subagents: z.array(child) })
        .nullable()
        .default(null),
      usage: usage.nullable().default(null),
    }),
  }),
  z.object({
    event: z.literal("result"),
    result: z.object({
      conversation_id: z.string(),
      status: z.enum(["SUCCESS", "ERROR"]),
      response: z.string().default(""),
      error: z.string().default("Antigravity turn failed"),
      denied_actions: z
        .array(z.object({ action: z.string(), display_name: z.string() }))
        .default([]),
    }),
  }),
]);
export type Frame = z.infer<typeof frame>;
export type Step = Extract<Frame, { event: "step_update" }>["step_update"];
export type Init = Extract<Frame, { event: "init" }>;
export type Tool = z.infer<typeof tool>;

export function decodeFrame(line: string): Frame {
  return frame.parse(JSON.parse(line));
}

export function encodePrompt(text: string): string {
  return `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
}

// `agy acp` speaks the Agent Client Protocol as newline-delimited JSON-RPC 2.0. Paseo uses it only
// to read a stored conversation: session/load streams it as session/update notifications.
const rpcId = z.union([z.number(), z.string()]);
const acpMessage = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: rpcId, method: z.string() }),
  z.object({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.unknown() }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: rpcId,
    error: z.object({ code: z.number(), message: z.string() }),
  }),
  z.object({ jsonrpc: z.literal("2.0"), id: rpcId, result: z.unknown() }),
]);
const acpNotification = z.object({
  sessionId: z.string(),
  update: z.object({ sessionUpdate: z.string() }).loose(),
});
const acpContent = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.enum(["image", "audio", "resource_link", "resource"]) }),
]);
const acpToolContent = z.union([
  z.object({ type: z.literal("content"), content: acpContent }),
  z.object({ type: z.enum(["diff", "terminal"]) }),
]);
const acpToolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
const acpUpdate = z.discriminatedUnion("sessionUpdate", [
  z.object({
    sessionUpdate: z.enum(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"]),
    content: acpContent,
  }),
  // Antigravity adds the native tool name and arguments to the ACP tool call.
  z.object({
    sessionUpdate: z.literal("tool_call"),
    toolCallId: z.string(),
    name: z.string().default(""),
    args: z.record(z.string(), z.json()).default({}),
    status: acpToolStatus.default("pending"),
    content: z.array(acpToolContent).default([]),
  }),
  z.object({
    sessionUpdate: z.literal("tool_call_update"),
    toolCallId: z.string(),
    name: z.string().optional(),
    args: z.record(z.string(), z.json()).optional(),
    status: acpToolStatus.optional(),
    content: z.array(acpToolContent).optional(),
  }),
]);
const historyUpdates = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
]);
export type AcpUpdate = z.infer<typeof acpUpdate>;
type RpcId = z.infer<typeof rpcId>;
export type AcpEvent =
  | { type: "request"; id: RpcId }
  | { type: "notification" }
  | { type: "update"; update: AcpUpdate }
  | { type: "error"; message: string }
  | { type: "result"; id: RpcId };

/** Classifies one line from `agy acp`, keeping only updates to the given session's conversation. */
export function decodeAcpEvent(line: string, sessionId: string): AcpEvent {
  const message = acpMessage.parse(JSON.parse(line));
  if ("method" in message) {
    if ("id" in message) return { type: "request", id: message.id };
    if (message.method !== "session/update") return { type: "notification" };
    const notification = acpNotification.parse(message.params);
    const kind = notification.update.sessionUpdate;
    if (notification.sessionId !== sessionId || !historyUpdates.has(kind))
      return { type: "notification" };
    return { type: "update", update: acpUpdate.parse(notification.update) };
  }
  if ("error" in message) return { type: "error", message: message.error.message };
  return { type: "result", id: message.id };
}

export function encodeRpc(message: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
}

export class AntigravityError extends Error {
  constructor(
    message: string,
    readonly code = "ANTIGRAVITY_ERROR",
  ) {
    super(message);
    this.name = "AntigravityError";
  }
}

export function diagnostic(message: string): string {
  if (/auth|sign.in|log.in/i.test(message)) {
    return "Antigravity authentication failed. Run `agy` and sign in, then retry.";
  }
  return message;
}
