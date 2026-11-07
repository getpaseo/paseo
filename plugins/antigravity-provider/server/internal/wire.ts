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

export function decodeFrame(line: string): Frame {
  return frame.parse(JSON.parse(line));
}

export function encodePrompt(text: string): string {
  return `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
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
