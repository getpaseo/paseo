/**
 * Some ACP agents (jcode) stream their reasoning inline inside
 * `agent_message_chunk` text using `<think>...</think>` markers instead of
 * emitting `agent_thought_chunk` updates. Without this, the raw tags and the
 * private reasoning render as assistant message text.
 *
 * The split is stateful because a marker can straddle chunk boundaries: a chunk
 * may end mid-marker (`"...<thi"`), so the trailing partial-marker candidate is
 * held back until the next chunk proves or disproves it.
 */

export interface InlineReasoningTags {
  open: string;
  close: string;
}

export const DEFAULT_INLINE_REASONING_TAGS: InlineReasoningTags = {
  open: "<think>",
  close: "</think>",
};

export interface InlineReasoningState {
  inReasoning: boolean;
  pending: string;
}

export type InlineReasoningSegmentKind = "text" | "reasoning";

export interface InlineReasoningSegment {
  kind: InlineReasoningSegmentKind;
  text: string;
}

export function createInlineReasoningState(): InlineReasoningState {
  return { inReasoning: false, pending: "" };
}

/**
 * Longest suffix of `value` that is a proper prefix of `marker`. That suffix is
 * an unresolved marker candidate and must not be emitted yet.
 */
function trailingPartialMarkerLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function pushSegment(
  segments: InlineReasoningSegment[],
  kind: InlineReasoningSegmentKind,
  text: string,
): void {
  if (!text) {
    return;
  }
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
    return;
  }
  segments.push({ kind, text });
}

export function splitInlineReasoning(
  state: InlineReasoningState,
  chunk: string,
  tags: InlineReasoningTags = DEFAULT_INLINE_REASONING_TAGS,
): InlineReasoningSegment[] {
  const segments: InlineReasoningSegment[] = [];
  state.pending += chunk;

  for (;;) {
    const marker = state.inReasoning ? tags.close : tags.open;
    const index = state.pending.indexOf(marker);
    if (index === -1) {
      break;
    }
    pushSegment(segments, state.inReasoning ? "reasoning" : "text", state.pending.slice(0, index));
    state.pending = state.pending.slice(index + marker.length);
    state.inReasoning = !state.inReasoning;
  }

  const marker = state.inReasoning ? tags.close : tags.open;
  const holdback = trailingPartialMarkerLength(state.pending, marker);
  const emitLength = state.pending.length - holdback;
  if (emitLength > 0) {
    pushSegment(
      segments,
      state.inReasoning ? "reasoning" : "text",
      state.pending.slice(0, emitLength),
    );
    state.pending = state.pending.slice(emitLength);
  }

  return segments;
}

/**
 * Flushes any held-back text at turn end so an unterminated marker candidate is
 * never silently dropped.
 */
export function flushInlineReasoning(state: InlineReasoningState): InlineReasoningSegment[] {
  if (!state.pending) {
    return [];
  }
  const segments: InlineReasoningSegment[] = [
    { kind: state.inReasoning ? "reasoning" : "text", text: state.pending },
  ];
  state.pending = "";
  return segments;
}
