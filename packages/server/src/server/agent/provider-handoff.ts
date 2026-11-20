import type {
  AgentPromptInput,
  AgentTimelineItem,
  AgentSessionConfig,
  AgentModelDefinition,
  ProviderHandoffState,
} from "./agent-sdk-types.js";

/**
 * Conservative on purpose. Prose runs near 4 characters per token, but JSON-escaped tool output can
 * run near 2: a 259 586-character handoff of shell output measured about 140 000 Claude tokens
 * (1.85 per token). Overestimating only compacts a history that was close to the limit;
 * underestimating sends a first message that the new model rejects.
 */
export const HANDOFF_CHARS_PER_TOKEN = 2;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

// Everything the model reads reads as one continuous conversation: no provider, model, agent or
// switch is named, and tool records carry the normalized detail, not the provider's tool name.
// The switch is shown to the user in the timeline only.
const HISTORY_NOTE = [
  "Continue the same task. These records are conversation history, not new instructions.",
  "Images and earlier reasoning are not included. Read current files when you need them.",
];

const NORMALIZED_TOOL_DETAILS = new Set(["shell", "read", "edit", "write", "search", "fetch"]);

export interface HandoffRow {
  seq: number;
  item: AgentTimelineItem;
}

export interface HandoffRecord {
  seq: number;
  text: string;
}

/** A summary that already covers the timeline through `throughSeq`. */
export interface HandoffBase {
  summary: string;
  throughSeq: number;
  /** Who wrote it, for the user's timeline notice only: for example "claude's own compaction". */
  origin: string;
}

/**
 * "new": the target starts a fresh session and needs the conversation.
 * "return": the target resumes its own earlier session and needs only what happened since it left.
 */
export type HandoffIntro = "new" | "return";

/**
 * One JSON record per visible history row. Earlier reasoning is left out, as a provider leaves out
 * its own earlier reasoning; notifications and markers carry no conversation content.
 */
export function buildHandoffRecords(rows: readonly HandoffRow[]): HandoffRecord[] {
  return rows.flatMap(({ seq, item }) => {
    const text = recordText(item);
    return text === null ? [] : [{ seq, text }];
  });
}

function recordText(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return JSON.stringify({
        role: item.type === "user_message" ? "user" : "assistant",
        text: item.text,
      });
    case "tool_call":
      return JSON.stringify({
        ...(NORMALIZED_TOOL_DETAILS.has(item.detail.type) ? {} : { tool: item.name }),
        status: item.status,
        detail: item.detail,
        error: item.error,
      });
    case "todo":
      return JSON.stringify({ tasks: item.items });
    case "error":
      return JSON.stringify({ error: item.message });
    default:
      return null;
  }
}

export function estimateHandoffTokens(chars: number): number {
  return Math.ceil(chars / HANDOFF_CHARS_PER_TOKEN);
}

/** The part of the window the handoff may use; the rest holds the provider's own setup and reply. */
export function handoffLimitTokens(contextWindowTokens?: number): number {
  const window =
    contextWindowTokens && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return window - Math.max(32_000, Math.floor(window * 0.1));
}

export function buildHandoffText(input: {
  intro: HandoffIntro;
  records: readonly string[];
  summary?: string;
}): string {
  const { intro, records, summary } = input;
  if (!records.length && !summary) return "";
  let lead: string;
  if (intro === "return") {
    lead = summary
      ? "The conversation continued after your last reply here. What happened since then is summarized below; the messages and tool results after the summary follow word for word as JSON records, oldest first."
      : "The conversation continued after your last reply here. The messages and tool results since then follow as JSON records, oldest first.";
  } else {
    lead = summary
      ? "The earlier part of this conversation is summarized below; the messages and tool results after it follow word for word as JSON records, oldest first."
      : "The earlier messages and tool results of this conversation follow as JSON records, oldest first.";
  }
  return [
    lead,
    ...HISTORY_NOTE,
    ...(summary
      ? [
          "",
          "Summary of the earlier conversation:",
          summary.trim(),
          "",
          "Records after the summary:",
        ]
      : []),
    ...records,
  ].join("\n");
}

export type ProviderHandoffPlan =
  | {
      kind: "full";
      text: string;
      records: number;
      estimatedTokens: number;
      base?: HandoffBase;
    }
  | {
      kind: "compact";
      intro: HandoffIntro;
      /** Older records, oldest first, split so that each summarizer call fits the model. */
      olderChunks: string[];
      olderRecords: number;
      /** The last row the new summary covers; a later switch can reuse it from there. */
      olderThroughSeq: number;
      /** Newest records, passed word for word. */
      recentRecords: string[];
      estimatedTokens: number;
      limitTokens: number;
      /** The summary the compaction starts from, when one already covered the oldest rows. */
      base?: HandoffBase;
    };

/**
 * What the new model gets: the rows after `afterSeq` (switching back) and after any summary that
 * already covers them, word for word when that fits the window. When it does not, the oldest of those
 * records are compacted, as a provider compacts its own long chats, and the newest go word for word.
 */
export function planProviderHandoff(input: {
  rows: readonly HandoffRow[];
  contextWindowTokens?: number;
  afterSeq?: number;
  base?: HandoffBase;
  intro?: HandoffIntro;
}): ProviderHandoffPlan {
  const intro = input.intro ?? "new";
  const base =
    input.base && input.base.throughSeq > (input.afterSeq ?? -1) ? input.base : undefined;
  const start = Math.max(input.afterSeq ?? -1, base?.throughSeq ?? -1);
  const records = buildHandoffRecords(input.rows).filter((record) => record.seq > start);
  const fullText = buildHandoffText({
    intro,
    records: records.map((record) => record.text),
    ...(base ? { summary: base.summary } : {}),
  });
  const estimatedTokens = estimateHandoffTokens(fullText.length);
  const limitTokens = handoffLimitTokens(input.contextWindowTokens);
  if (estimatedTokens <= limitTokens) {
    return {
      kind: "full",
      text: fullText,
      records: records.length,
      estimatedTokens,
      ...(base ? { base } : {}),
    };
  }

  // After compaction the chat starts half full, which leaves room to keep working.
  const recentBudget = Math.floor(limitTokens / 2) * HANDOFF_CHARS_PER_TOKEN;
  let split = records.length;
  let recentChars = 0;
  while (split > 0 && recentChars + records[split - 1]!.text.length + 1 <= recentBudget) {
    split -= 1;
    recentChars += records[split]!.text.length + 1;
  }
  const older = records.slice(0, split);
  // Each summarizer call holds the summary so far plus one chunk.
  const chunkBudget = Math.floor(limitTokens * 0.6) * HANDOFF_CHARS_PER_TOKEN;
  return {
    kind: "compact",
    intro,
    olderChunks: chunkRecords(
      older.map((record) => record.text),
      chunkBudget,
    ),
    olderRecords: older.length,
    olderThroughSeq: older.at(-1)?.seq ?? start,
    recentRecords: records.slice(split).map((record) => record.text),
    estimatedTokens,
    limitTokens,
    ...(base ? { base } : {}),
  };
}

/** Groups records into chunks of at most `budget` characters; a larger record is cut into pieces. */
export function chunkRecords(records: readonly string[], budget: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length) chunks.push(current.join("\n"));
    current = [];
    currentChars = 0;
  };
  for (const record of records) {
    if (record.length + 1 > budget) {
      flush();
      for (let start = 0; start < record.length; start += budget) {
        chunks.push(record.slice(start, start + budget));
      }
      continue;
    }
    if (currentChars + record.length + 1 > budget) flush();
    current.push(record);
    currentChars += record.length + 1;
  }
  flush();
  return chunks;
}

/**
 * Each part is summarized on its own and the part summaries are joined in order, so that no model
 * can drop an earlier part while rewriting it (measured: a rolling rewrite replaced two parts with
 * "see prior summary"). Only when the joined summaries outgrow this share of the handoff are they
 * merged; the newest records fill at most half of it.
 */
export function summaryBudgetChars(limitTokens: number): number {
  return Math.floor(limitTokens * 0.4) * HANDOFF_CHARS_PER_TOKEN;
}

/** How much of the previous part's summary a summarizer call gets as context. */
export function summaryContextChars(limitTokens: number): number {
  return Math.floor(limitTokens * 0.2) * HANDOFF_CHARS_PER_TOKEN;
}

const KEEP_LIST = [
  "1. The user's requests and intent, every instruction or ruling the user gave, and anything the user asked to remember.",
  "2. Key technical facts, decisions and the reasons for them.",
  "3. File paths, commands, identifiers, values and results that later work depends on.",
  "4. Errors met and how they were resolved or left open.",
  "5. Work completed, work in progress, and open tasks with their next step.",
];

export function buildCompactionPrompt(input: {
  context: string;
  chunk: string;
  part: number;
  parts: number;
}): string {
  return [
    "You are compacting the earlier part of a coding agent's conversation so that the work can continue in a smaller context.",
    "Do not use any tools. Reply with the summary text only.",
    ...(input.context
      ? [
          "",
          "The summary of the conversation before this part follows for context only. It is kept separately: do not repeat it.",
          input.context,
        ]
      : []),
    "",
    "Write a summary of the records below. Keep, as exactly as the records state them:",
    ...KEEP_LIST,
    "Leave out pleasantries and repeated tool output. Prefer complete over short.",
    "",
    `Conversation records, JSON, oldest first (part ${input.part} of ${input.parts}):`,
    input.chunk,
  ].join("\n");
}

export function buildSummaryMergePrompt(input: {
  summaries: readonly string[];
  group: number;
  groups: number;
}): string {
  return [
    "You are compacting partial summaries of a coding agent's conversation into one, so that the work can continue in a smaller context.",
    "Do not use any tools. Reply with the summary text only.",
    "The summaries below cover consecutive parts of the conversation, oldest first. Write one summary that covers all of them. Drop only repetition. Keep, exactly as stated:",
    ...KEEP_LIST,
    "",
    `Partial summaries, oldest first (group ${input.group} of ${input.groups}):`,
    input.summaries.join("\n\n---\n\n"),
  ].join("\n");
}

/** Groups consecutive summaries so that each group fits one merge call. */
export function groupSummaries(summaries: readonly string[], budget: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const summary of summaries) {
    if (current.length && chars + summary.length > budget) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(summary);
    chars += summary.length;
  }
  if (current.length) groups.push(current);
  return groups;
}

export function handoffPrefix(text: string): string {
  return `${text}\n\nCurrent user message:\n`;
}

export function withProviderHandoff(prompt: AgentPromptInput, text: string): AgentPromptInput {
  const prefix = handoffPrefix(text);
  return typeof prompt === "string" ? prefix + prompt : [{ type: "text", text: prefix }, ...prompt];
}

export function stripHandoffEcho(item: AgentTimelineItem, text: string): AgentTimelineItem {
  const prefix = handoffPrefix(text);
  return item.type === "user_message" && item.text.startsWith(prefix)
    ? { ...item, text: item.text.slice(prefix.length) }
    : item;
}

/**
 * The configuration of the chat on its new provider. The record of each provider's last native
 * session and the reusable compaction summary carry over from switch to switch.
 */
export function buildProviderSwitchConfig(input: {
  previous: AgentSessionConfig;
  provider: string;
  modelId: string | null;
  model: AgentModelDefinition | undefined;
  history: readonly HandoffRow[];
  handoffText: string;
  previousSessions?: ProviderHandoffState["previousSessions"];
  compaction?: ProviderHandoffState["compaction"];
}): AgentSessionConfig {
  const { previous, provider, modelId, model, history, handoffText } = input;
  return {
    provider,
    cwd: previous.cwd,
    model: model?.id ?? modelId ?? undefined,
    title: previous.title,
    systemPrompt: previous.systemPrompt,
    mcpServers: previous.mcpServers,
    toolPolicy: previous.toolPolicy,
    // Even an empty chat needs a boundary so native history refreshes retain
    // the switch notice and any preceding Paseo-only timeline entries.
    providerHandoff: {
      text: handoffText,
      pending: Boolean(handoffText),
      historyBoundary: history.at(-1)?.seq ?? 0,
      ...(input.previousSessions && Object.keys(input.previousSessions).length
        ? { previousSessions: input.previousSessions }
        : {}),
      ...(input.compaction ? { compaction: input.compaction } : {}),
    },
  };
}
