import type { ProjectedTimelineRow } from "../../timeline-projection.js";
import type { TimelineEntry, TimelinePrompt } from "./backend.js";

export type ProviderHistoryPlan =
  | { kind: "unchanged" }
  | { kind: "append"; entries: TimelineEntry[] }
  | { kind: "diverged"; reason: string };

interface Prompt {
  id: string | undefined;
  text: string;
}

interface ProviderPrompt extends Prompt {
  start: number;
}

/**
 * Sync only whole new turns. The provider's prompts must start with Paseo's acknowledged prompts
 * in order, with matching IDs and text. Live output and replay may represent the same turn
 * differently, so neither decides whether an existing turn matches.
 */
export function planProviderHistory(input: {
  rows: readonly ProjectedTimelineRow[];
  prompts: readonly TimelinePrompt[];
  provider: readonly TimelineEntry[];
  activeSegmentStartSeq?: number;
}): ProviderHistoryPlan {
  const segmentStart = input.activeSegmentStartSeq ?? 0;
  const segmentRows =
    segmentStart > 0 ? input.rows.filter((row) => row.seqStart > segmentStart) : input.rows;
  const segmentPrompts =
    segmentStart > 0
      ? input.prompts.filter((prompt) => prompt.seqStart > segmentStart)
      : input.prompts;
  const owned = ownedPrompts(segmentRows, segmentPrompts);
  const provider = providerPrompts(input.provider);
  if ([...owned.prompts, ...provider].some((prompt) => prompt.id === undefined)) {
    return { kind: "diverged", reason: "A prompt has no provider id" };
  }
  if (owned.prompts.length > provider.length) {
    return { kind: "diverged", reason: "The provider history is missing turns Paseo shows" };
  }
  if (provider.some((prompt, index) => index > 0 && prompt.id === provider[index - 1].id)) {
    return { kind: "diverged", reason: "The provider history has two prompts with one id" };
  }
  if (owned.prompts.some((prompt, index) => !samePrompt(prompt, provider[index]))) {
    return { kind: "diverged", reason: "The provider history has different prompts" };
  }

  const next = provider[owned.prompts.length];
  if (!next) return { kind: "unchanged" };
  if (owned.trailingUndeliveredPrompt) {
    return { kind: "diverged", reason: "A prompt the provider did not receive is last" };
  }
  return { kind: "append", entries: input.provider.slice(next.start) };
}

function ownedPrompts(
  rows: readonly ProjectedTimelineRow[],
  prompts: readonly TimelinePrompt[],
): { prompts: Prompt[]; trailingUndeliveredPrompt: boolean } {
  const promptsBySeq = new Map(prompts.map((prompt) => [prompt.seqStart, prompt]));
  const acknowledged: Prompt[] = [];
  let trailingUndeliveredPrompt = false;
  for (const row of rows) {
    if (row.item.type !== "user_message") continue;
    const prompt = promptsBySeq.get(row.seqStart);
    if (!prompt) continue;
    trailingUndeliveredPrompt = prompt.submitted && !prompt.providerMessageId;
    if (!trailingUndeliveredPrompt) {
      acknowledged.push({
        id: prompt.providerMessageId ?? prompt.messageId,
        text: row.providerPromptText ?? row.item.text,
      });
    }
  }
  return { prompts: acknowledged, trailingUndeliveredPrompt };
}

function providerPrompts(entries: readonly TimelineEntry[]): ProviderPrompt[] {
  const prompts: ProviderPrompt[] = [];
  entries.forEach(({ item }, start) => {
    if (item.type !== "user_message") return;
    const prompt = { id: item.messageId, text: item.text, start };
    const previous = prompts.at(-1);
    // Some providers replay a prompt twice. Reusing an ID for different text is a mismatch.
    if (previous && prompt.id !== undefined && samePrompt(prompt, previous)) return;
    prompts.push(prompt);
  });
  return prompts;
}

function samePrompt(a: Prompt, b: Prompt): boolean {
  return a.id === b.id && a.text === b.text;
}
