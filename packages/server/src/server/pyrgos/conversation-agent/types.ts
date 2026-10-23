export const MODEL_FLAGS = ["haiku", "sonnet", "opus"] as const;
export type ModelFlag = (typeof MODEL_FLAGS)[number];
/** Opus won the MIC-749 bench. */
export const DEFAULT_MODEL: ModelFlag = "opus";
/** These get the filler on every non-trivial turn. */
export const SLOW_MODELS: readonly ModelFlag[] = ["sonnet", "opus"];

export function parseModelFlag(value: string | undefined): ModelFlag {
  const v = value?.trim().toLowerCase();
  return (MODEL_FLAGS as readonly string[]).includes(v ?? "") ? (v as ModelFlag) : DEFAULT_MODEL;
}

/** What a brain reports while it works one turn. */
export type BrainEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string }
  | { type: "tool_result" };

/**
 * The thinking side of a turn. The production brain is a warm Claude Agent SDK session on the
 * subscription login; tests supply a fake. `runTurn` must end (not throw) after `interrupt`.
 */
export interface Brain {
  runTurn(userText: string): AsyncIterable<BrainEvent>;
  /** Stop the running turn and drain it so the next turn starts clean. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/**
 * What the agent emits. `assistant_chunk` is text for the transcript; `speak` is text to
 * synthesize (the speech providers turn it into `audio_output`). They carry the same chunks.
 */
export type ConversationEvent =
  | { type: "assistant_chunk"; turnId: number; text: string }
  | { type: "speak"; turnId: number; text: string; kind: "filler" | "reply" }
  | { type: "turn_end"; turnId: number }
  | { type: "interrupted"; turnId: number }
  | { type: "error"; turnId: number; message: string };
