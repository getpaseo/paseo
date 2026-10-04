import { curateAgentActivity } from "../activity-curator.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import {
  buildMetadataPrompt,
  type RepoRootResolver,
} from "../../../utils/build-metadata-prompt.js";
import { PROMPT_SUGGESTION_MAX_CHARS, PROMPT_SUGGESTION_MAX_COUNT } from "./types.js";

// Suggestions guess the next message, not a summary of the session, so the last
// exchange carries almost all the signal.
export const PROMPT_SUGGESTION_CONTEXT_CHARS = 12_000;

// Messages only. A tool call's display summary is its shell command, search
// query or fetch URL, and a sub-agent's log carries file contents, so no tool
// item may reach a model that is not the one already running this agent.
const CONTEXT_KINDS: readonly AgentTimelineItem["type"][] = ["user_message", "assistant_message"];

export interface BuildPromptSuggestionPromptInput {
  timeline: readonly AgentTimelineItem[];
  agentTitle?: string | null;
  cwd?: string | null;
  maxContextChars?: number;
  workspaceGitService?: RepoRootResolver;
}

export interface BuiltPromptSuggestionPrompt {
  prompt: string;
  contextChars: number;
  truncated: boolean;
}

// Null means nothing worth guessing from: skip the generation rather than spend
// a call on an empty agent.
export async function buildPromptSuggestionPrompt(
  input: BuildPromptSuggestionPromptInput,
): Promise<BuiltPromptSuggestionPrompt | null> {
  if (!hasConversation(input.timeline)) {
    return null;
  }

  const activity = curateAgentActivity([...input.timeline], {
    labelAssistantMessages: true,
    includeKinds: CONTEXT_KINDS,
    includeExternalToolInput: false,
  });
  const limit = input.maxContextChars ?? PROMPT_SUGGESTION_CONTEXT_CHARS;
  const context = takeTail(activity, limit);
  if (!context.text.trim()) {
    return null;
  }

  const header = buildHeader(input);
  const conversation = `<conversation>\n${context.text}\n</conversation>`;
  const prompt = await buildMetadataPrompt({
    cwd: input.cwd ?? "",
    workspaceGitService: input.workspaceGitService,
    contract: CONTRACT,
    styles: [{ configKey: "promptSuggestions", default: RULES }],
    after: [header, conversation].filter((section) => Boolean(section)).join("\n\n"),
    trailing: JSON_SHAPE,
  });

  return {
    prompt,
    contextChars: context.text.length,
    truncated: context.truncated,
  };
}

function hasConversation(timeline: readonly AgentTimelineItem[]): boolean {
  return timeline.some(
    (item) =>
      (item.type === "user_message" || item.type === "assistant_message") &&
      item.text.trim().length > 0,
  );
}

// Cut on a line boundary so a suggestion is never built from half a tool summary.
function takeTail(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const tail = text.slice(text.length - limit);
  const firstBreak = tail.indexOf("\n");
  const trimmed = firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail;
  return { text: trimmed, truncated: true };
}

function buildHeader(input: BuildPromptSuggestionPromptInput): string | undefined {
  const lines: string[] = [];
  const title = input.agentTitle?.trim();
  const cwd = input.cwd?.trim();
  if (title) {
    lines.push(`Agent: ${title}`);
  }
  if (cwd) {
    lines.push(`Working directory: ${cwd}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

const CONTRACT = [
  "You predict what a developer will type next to a coding agent.",
  "Below is the tail of their conversation. The agent has just finished its turn",
  "and the developer's input box is empty. Write the messages they are most",
  `likely to send next: at least one, at most ${PROMPT_SUGGESTION_MAX_COUNT}, best guess first.`,
].join(" ");

// Replaceable wholesale from paseo.json metadataGeneration.promptSuggestions.instructions,
// so a repo can steer the wording; the contract and JSON shape around it cannot be overridden.
const RULES = [
  "Rules:",
  "- Write as the developer, addressing the agent: imperative, first person.",
  `- One line each, at most ${PROMPT_SUGGESTION_MAX_CHARS} characters, no numbering or quotes.`,
  "- Be specific to this conversation: name the file, test, branch or error in it.",
  "- If the agent asked the developer a question, make the first suggestion answer it.",
  "- Never suggest work the agent already finished in this conversation.",
  "- No filler like 'continue' or 'looks good': instruct, or ask something specific about this work.",
  "- Write in the language the developer has been using.",
].join("\n");

const JSON_SHAPE = 'Return JSON only: {"suggestions": ["...", "..."]}';
