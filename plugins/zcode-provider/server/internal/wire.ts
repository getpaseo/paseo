import { z } from "zod";

/**
 * ZCode's session event types. An event whose type is not on this list is
 * ignored: ZCode adds types over time, and one the provider cannot map
 * carries nothing worth keeping.
 *
 * Source: `packages/shared/src/zcode-protocol/index.ts` in the ZCode repository.
 */
const ZCODE_EVENT_TYPES = [
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "userInput.requested",
  "userInput.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
] as const;

/**
 * ZCode's own envelope is strict, and it keeps gaining fields. This one
 * tolerates them: an unknown field must not drop a whole turn. Unknown
 * fields are dropped from the frame.
 */
const eventFrameSchema = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative(),
  timestamp: z.number(),
  type: z.enum(ZCODE_EVENT_TYPES),
  payload: z.unknown().optional(),
});

const responseFrameSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .optional(),
  })
  // A response frame carries a result or an error. Without this, a bare
  // `{ id }` frame parses as a successful response with an undefined result,
  // and the pending request resolves with nothing.
  .refine((value) => value.result !== undefined || value.error !== undefined, {
    message: "A response frame carries a result or an error",
  });

/**
 * A request ZCode sends to the host. ZCode asks the host for permission with
 * one, so the host has to answer it.
 */
const requestFrameSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type ZCodeEventFrame = z.infer<typeof eventFrameSchema>;

export interface ZCodeRequestFrame {
  id: string;
  method: string;
  params?: unknown;
}

export type ZCodeFrame =
  | ({ kind: "request" } & ZCodeRequestFrame)
  | ({ kind: "event" } & ZCodeEventFrame)
  | { kind: "response"; id: string; result: unknown }
  | { kind: "error"; id: string; code: number; message: string; data?: unknown };

export class ZCodeError extends Error {
  constructor(
    message: string,
    readonly code = "ZCODE_ERROR",
    readonly protocolCode?: number,
  ) {
    super(message);
    this.name = "ZCodeError";
  }
}

export function decodeFrame(line: string): ZCodeFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  // A request carries a method and no result; an event carries a type and no
  // method; a response carries neither. The shapes are disjoint, so the order
  // does not matter, and a request is checked first because ZCode sends one
  // asking the host for permission.
  const request = requestFrameSchema.safeParse(parsed);
  if (request.success) {
    return {
      kind: "request",
      id: String(request.data.id),
      method: request.data.method,
      params: request.data.params,
    };
  }
  const event = eventFrameSchema.safeParse(parsed);
  if (event.success) return { kind: "event", ...event.data };
  const response = responseFrameSchema.safeParse(parsed);
  if (!response.success) return undefined;
  if (response.data.error) {
    return {
      kind: "error",
      id: String(response.data.id),
      code: response.data.error.code,
      message: response.data.error.message,
      data: response.data.error.data,
    };
  }
  return { kind: "response", id: String(response.data.id), result: response.data.result };
}

export function encodeRequest(id: string, method: string, params?: unknown): string {
  const frame: Record<string, unknown> = { id, method };
  if (params !== undefined) frame.params = params;
  return `${JSON.stringify(frame)}\n`;
}

export function encodeResponse(id: string, result: unknown): string {
  return `${JSON.stringify({ id, result })}\n`;
}

export function encodeError(id: string, code: number, message: string): string {
  return `${JSON.stringify({ id, error: { code, message } })}\n`;
}
