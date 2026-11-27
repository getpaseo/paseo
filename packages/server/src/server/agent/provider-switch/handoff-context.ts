import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type {
  AgentPromptInput,
  AgentProvider,
  AgentTimelineItem,
  ProviderSwitchContextSummary,
} from "../agent-sdk-types.js";
import type { ProjectedTimelineRow } from "../timeline-projection.js";
import {
  curateProjectedActivityEntries,
  MAX_FORK_CONTEXT_CHARS,
  type ActivityEntry,
} from "../activity-curator.js";

export const HANDOFF_TAIL_LIMIT = 80;
export const MAX_HANDOFF_CONTEXT_CHARS = MAX_FORK_CONTEXT_CHARS;
const MAX_HANDOFF_METADATA_CHARS = 1_000;
const HANDOFF_OMITTED_MARKER = "[Earlier chat history omitted]\n";
const HANDOFF_CONTEXT_KINDS: readonly AgentTimelineItem["type"][] = [
  "user_message",
  "assistant_message",
  "tool_call",
  "provider_switch",
];

type TextAgentAttachment = Extract<AgentAttachment, { type: "text" }>;

export interface ProviderSwitchHandoffResult {
  attachment: TextAgentAttachment | null;
  summary: ProviderSwitchContextSummary;
}

function trimMetadata(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_HANDOFF_METADATA_CHARS) : null;
}

function wrapHandoffContextText(input: {
  body: string;
  fromProvider: AgentProvider;
  toProvider: AgentProvider;
  agentTitle?: string | null;
  cwd?: string | null;
}): string {
  const header = [
    `Chat history from this Paseo conversation before switching from ${input.fromProvider} to ${input.toProvider}.`,
  ];
  const agentTitle = trimMetadata(input.agentTitle);
  const cwd = trimMetadata(input.cwd);
  if (agentTitle) header.push(`Conversation: ${agentTitle}`);
  if (cwd) header.push(`Directory: ${cwd}`);
  return `<chat-history-summary>\n${header.join("\n")}\n\n${input.body}\n</chat-history-summary>`;
}

function fitHandoffEntries(
  entries: readonly ActivityEntry[],
  budget: number,
  alreadyHasOlder: boolean,
): { body: string; includedItems: number; charBudgetTruncated: boolean } {
  const prefix = alreadyHasOlder ? HANDOFF_OMITTED_MARKER : "";
  const fullJoined = entries.map((entry) => entry.text).join("\n");
  if (prefix.length + fullJoined.length <= budget) {
    return {
      body: prefix + fullJoined,
      includedItems: entries.length,
      charBudgetTruncated: false,
    };
  }

  const selected: string[] = [];
  let remaining = Math.max(0, budget - HANDOFF_OMITTED_MARKER.length);
  for (let index = entries.length - 1; index >= 0; index--) {
    const text = entries[index]!.text;
    const size = text.length + (selected.length > 0 ? 1 : 0);
    if (size > remaining) {
      if (selected.length === 0 && remaining > 0) {
        const marker = "\n[Message truncated]\n";
        if (remaining > marker.length + 2) {
          const available = remaining - marker.length;
          const head = Math.ceil(available / 2);
          selected.push(text.slice(0, head) + marker + text.slice(-(available - head)));
        } else {
          selected.push(text.slice(0, remaining));
        }
      }
      break;
    }
    selected.push(text);
    remaining -= size;
  }

  return {
    body: HANDOFF_OMITTED_MARKER + selected.toReversed().join("\n"),
    includedItems: selected.length,
    charBudgetTruncated: true,
  };
}

export function buildProviderSwitchHandoff(input: {
  rows: readonly ProjectedTimelineRow[];
  hasOlder: boolean;
  fromProvider: AgentProvider;
  toProvider: AgentProvider;
  agentTitle?: string | null;
  cwd?: string | null;
  budgetChars?: number;
}): ProviderSwitchHandoffResult {
  const budgetChars = input.budgetChars ?? MAX_HANDOFF_CONTEXT_CHARS;
  const tailWindowExceeded = input.rows.length > HANDOFF_TAIL_LIMIT;
  const boundedRows = tailWindowExceeded ? input.rows.slice(-HANDOFF_TAIL_LIMIT) : input.rows;
  const hasOlder = input.hasOlder || tailWindowExceeded;
  const entries = curateProjectedActivityEntries(
    boundedRows.map((row) => row.item),
    {
      maxItems: 0,
      labelAssistantMessages: true,
      includeKinds: HANDOFF_CONTEXT_KINDS,
      includeExternalToolInput: false,
    },
  );

  if (entries.length === 0 && !hasOlder) {
    return {
      attachment: null,
      summary: {
        includedItems: 0,
        truncated: false,
        charCount: 0,
        budgetChars,
      },
    };
  }

  const wrapperOverhead = wrapHandoffContextText({
    body: "",
    fromProvider: input.fromProvider,
    toProvider: input.toProvider,
    agentTitle: input.agentTitle,
    cwd: input.cwd,
  }).length;
  const bodyBudget = Math.max(0, budgetChars - wrapperOverhead);

  const fitted =
    entries.length > 0
      ? fitHandoffEntries(entries, bodyBudget, hasOlder)
      : { body: HANDOFF_OMITTED_MARKER.trimEnd(), includedItems: 0, charBudgetTruncated: false };

  const omittedReasons: string[] = [];
  if (hasOlder) omittedReasons.push("tail_window_limit");
  if (fitted.charBudgetTruncated) omittedReasons.push("char_budget");

  const text = wrapHandoffContextText({
    body: fitted.body,
    fromProvider: input.fromProvider,
    toProvider: input.toProvider,
    agentTitle: input.agentTitle,
    cwd: input.cwd,
  });

  return {
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text,
    },
    summary: {
      includedItems: fitted.includedItems,
      truncated: omittedReasons.length > 0,
      charCount: text.length,
      budgetChars,
      ...(omittedReasons.length > 0 ? { omittedReasons } : {}),
    },
  };
}

export function promptHasChatHistoryAttachment(prompt: AgentPromptInput): boolean {
  if (!Array.isArray(prompt)) return false;
  return prompt.some(
    (block) =>
      block.type === "text" && "contextKind" in block && block.contextKind === "chat_history",
  );
}

export function prependHandoffAttachment(
  prompt: AgentPromptInput,
  attachment: TextAgentAttachment | null,
): AgentPromptInput {
  if (!attachment) return prompt;
  if (typeof prompt === "string") {
    return [attachment, { type: "text", text: prompt }];
  }
  if (!Array.isArray(prompt)) {
    return prompt;
  }
  return [attachment, ...prompt];
}

export function renderProviderPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim();
}
