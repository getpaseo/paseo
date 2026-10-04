import { z } from "zod";
import {
  PROMPT_SUGGESTION_MAX_CHARS,
  PROMPT_SUGGESTION_MAX_COUNT,
  type PromptSuggestion,
} from "@getpaseo/protocol/messages";

export { PROMPT_SUGGESTION_MAX_CHARS, PROMPT_SUGGESTION_MAX_COUNT };
export type { PromptSuggestion };

// The model is asked for plain strings; ids are stamped here so the app can key
// a list without trusting the model to invent unique ones.
export const PROMPT_SUGGESTIONS_SCHEMA = z.object({
  suggestions: z
    .array(
      z
        .string()
        .min(1)
        .max(PROMPT_SUGGESTION_MAX_CHARS * 2),
    )
    .min(1),
});

export type PromptSuggestionsResponse = z.infer<typeof PROMPT_SUGGESTIONS_SCHEMA>;

export const PROMPT_SUGGESTIONS_SCHEMA_NAME = "PromptSuggestions";

// A model that ignores the character cap gets trimmed rather than dropped: a
// clipped-but-specific suggestion is still worth showing.
export function normalizeSuggestions(raw: readonly string[]): PromptSuggestion[] {
  const seen = new Set<string>();
  const out: PromptSuggestion[] = [];
  for (const entry of raw) {
    const text = clip(stripListMarkers(entry));
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ id: `s${out.length + 1}`, text });
    if (out.length >= PROMPT_SUGGESTION_MAX_COUNT) {
      break;
    }
  }
  return out;
}

function stripListMarkers(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

function clip(value: string): string {
  if (value.length <= PROMPT_SUGGESTION_MAX_CHARS) {
    return value;
  }
  const head = value.slice(0, PROMPT_SUGGESTION_MAX_CHARS - 1);
  const lastSpace = head.lastIndexOf(" ");
  const body = lastSpace > PROMPT_SUGGESTION_MAX_CHARS / 2 ? head.slice(0, lastSpace) : head;
  return `${body.trimEnd()}…`;
}
