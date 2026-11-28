import { z } from "zod";
import { TerminalStateSchema } from "../messages.js";
export {
  TerminalStreamOpcode,
  asUint8Array,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  parseTerminalReplayMetadata,
  type TerminalReplayMetadata,
  type TerminalStreamFrame,
} from "./terminal-wire.js";

export const TerminalReplayMetadataSchema = z.object({
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  retainedHistoryLines: z.number().int().nonnegative(),
});

export const TerminalStreamResizeSchema = z.object({
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  intent: z.enum(["claim", "update"]).optional(),
});

export function encodeTerminalSnapshotPayload(
  state: z.infer<typeof TerminalStateSchema>,
): Uint8Array {
  return encodeJsonPayload(state);
}

export function decodeTerminalSnapshotPayload(
  bytes: Uint8Array,
): z.infer<typeof TerminalStateSchema> | null {
  const parsed = decodeJsonPayload(bytes);
  const result = TerminalStateSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function encodeTerminalResizePayload(
  input: z.infer<typeof TerminalStreamResizeSchema>,
): Uint8Array {
  return encodeJsonPayload(input);
}

export function decodeTerminalResizePayload(
  bytes: Uint8Array,
): z.infer<typeof TerminalStreamResizeSchema> | null {
  const parsed = decodeJsonPayload(bytes);
  const result = TerminalStreamResizeSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function encodeJsonPayload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodeJsonPayload(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}
