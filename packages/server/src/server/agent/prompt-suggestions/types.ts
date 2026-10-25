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

// Drafted answers name the question they answer by the number the prompt gave
// it, so a card with several questions can show each only its own.
export const QUESTION_ANSWERS_SCHEMA = z.object({
  answers: z
    .array(
      z.object({
        question: z.number().int(),
        suggestions: z
          .array(
            z
              .string()
              .min(1)
              .max(PROMPT_SUGGESTION_MAX_CHARS * 2),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type QuestionAnswersResponse = z.infer<typeof QUESTION_ANSWERS_SCHEMA>;

export const QUESTION_ANSWERS_SCHEMA_NAME = "QuestionAnswers";

// A model that ignores the character cap gets trimmed rather than dropped: a
// clipped-but-specific suggestion is still worth showing.
export function normalizeSuggestions(raw: readonly string[]): PromptSuggestion[] {
  return cleanTexts(raw)
    .slice(0, PROMPT_SUGGESTION_MAX_COUNT)
    .map((text, index) => ({ id: `s${index + 1}`, text }));
}

/**
 * Drafted answers, each stamped with the index of the question it answers.
 * `answerable` maps the 1-based number each question carried in the prompt to
 * its index in the card; an answer to any other number is dropped, never
 * guessed onto a question. The payload cap is shared, so questions take turns
 * and each of the first few gets its best guess before any gets a second.
 */
export function normalizeQuestionAnswers(
  raw: QuestionAnswersResponse["answers"],
  answerable: ReadonlyMap<number, number>,
): PromptSuggestion[] {
  const byIndex = new Map<number, string[]>();
  for (const entry of raw) {
    const questionIndex = answerable.get(entry.question);
    if (questionIndex === undefined) {
      continue;
    }
    byIndex.set(questionIndex, [...(byIndex.get(questionIndex) ?? []), ...entry.suggestions]);
  }
  const queues = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([questionIndex, texts]) => ({ questionIndex, texts: cleanTexts(texts) }));

  const out: PromptSuggestion[] = [];
  const rounds = Math.max(0, ...queues.map((queue) => queue.texts.length));
  for (let round = 0; round < rounds; round += 1) {
    for (const { questionIndex, texts } of queues) {
      const text = texts[round];
      if (text === undefined) {
        continue;
      }
      if (out.length >= PROMPT_SUGGESTION_MAX_COUNT) {
        return out;
      }
      out.push({ id: `s${out.length + 1}`, text, questionIndex });
    }
  }
  return out;
}

function cleanTexts(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const text = clip(stripListMarkers(entry));
    const key = text.toLowerCase();
    if (!text || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(text);
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
