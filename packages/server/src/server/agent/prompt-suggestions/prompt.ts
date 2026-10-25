import { curateAgentActivity } from "../activity-curator.js";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import {
  buildMetadataPrompt,
  type RepoRootResolver,
} from "../../../utils/build-metadata-prompt.js";
import { PROMPT_SUGGESTION_MAX_CHARS, PROMPT_SUGGESTION_MAX_COUNT } from "./types.js";
import {
  questionShowsTextInput,
  type QuestionFormQuestion,
} from "@getpaseo/protocol/question-form";
import type { NewChatWorkspaceContext } from "./workspace-context.js";

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

export interface BuildQuestionAnswerPromptInput extends BuildPromptSuggestionPromptInput {
  // Every question on the card, in the order the agent asked them.
  questions: readonly QuestionFormQuestion[];
}

export interface BuiltQuestionAnswerPrompt extends BuiltPromptSuggestionPrompt {
  // The number each answerable question carries in the prompt, to its card index.
  answerable: ReadonlyMap<number, number>;
}

/**
 * Answers to a question the agent asked, for the question card's own answer box.
 * Null when no question carries a free-text box: a question that only offers
 * options is answered by picking one, and a guess there would just be noise.
 */
export async function buildQuestionAnswerPrompt(
  input: BuildQuestionAnswerPromptInput,
): Promise<BuiltQuestionAnswerPrompt | null> {
  // Numbered by position on the card, so "Question 2" is the card's second question
  // even when the first only offers options and is left out.
  const answerable = new Map<number, number>();
  const asked: string[] = [];
  input.questions.forEach((question, index) => {
    if (questionShowsTextInput(question)) {
      answerable.set(index + 1, index);
      asked.push(renderQuestion(index + 1, question));
    }
  });
  if (answerable.size === 0) {
    return null;
  }

  const activity = curateAgentActivity([...input.timeline], {
    labelAssistantMessages: true,
    includeKinds: CONTEXT_KINDS,
    includeExternalToolInput: false,
  });
  const context = takeTail(activity, input.maxContextChars ?? PROMPT_SUGGESTION_CONTEXT_CHARS);
  const header = buildHeader(input);
  const conversation = context.text.trim()
    ? `<conversation>\n${context.text}\n</conversation>`
    : "";
  const prompt = await buildMetadataPrompt({
    cwd: input.cwd ?? "",
    workspaceGitService: input.workspaceGitService,
    contract: QUESTION_CONTRACT,
    styles: [{ configKey: "promptSuggestions", default: QUESTION_RULES }],
    after: [header, conversation, `<questions>\n${asked.join("\n\n")}\n</questions>`]
      .filter((section) => Boolean(section))
      .join("\n\n"),
    trailing: QUESTION_JSON_SHAPE,
  });

  return {
    prompt,
    contextChars: context.text.length,
    truncated: context.truncated,
    answerable,
  };
}

export interface BuildNewChatSuggestionPromptInput extends Omit<
  BuildPromptSuggestionPromptInput,
  "timeline"
> {
  workspace: NewChatWorkspaceContext;
}

/**
 * First prompts for a chat that has no conversation yet, guessed from the
 * checkout the agent starts in: branch, uncommitted paths and recent subjects.
 * Null when the repository says nothing — an empty directory gets no guess.
 */
export async function buildNewChatSuggestionPrompt(
  input: BuildNewChatSuggestionPromptInput,
): Promise<BuiltPromptSuggestionPrompt | null> {
  const workspace = renderWorkspace(input.workspace);
  if (!workspace) {
    return null;
  }

  const header = buildHeader({ ...input, timeline: [] });
  const prompt = await buildMetadataPrompt({
    cwd: input.cwd ?? "",
    workspaceGitService: input.workspaceGitService,
    contract: NEW_CHAT_CONTRACT,
    styles: [{ configKey: "newChatSuggestions", default: NEW_CHAT_RULES }],
    after: [header, `<workspace>\n${workspace}\n</workspace>`]
      .filter((section) => Boolean(section))
      .join("\n\n"),
    trailing: JSON_SHAPE,
  });

  return {
    prompt,
    contextChars: workspace.length,
    truncated: input.workspace.moreChangedPaths > 0,
  };
}

function renderWorkspace(workspace: NewChatWorkspaceContext): string | null {
  const lines: string[] = [];
  if (workspace.branch) {
    lines.push(`Branch: ${workspace.branch}`);
  }
  if (workspace.recentCommits.length > 0) {
    lines.push(
      `Recent commits:\n${workspace.recentCommits.map((subject) => `- ${subject}`).join("\n")}`,
    );
  }
  if (workspace.changedPaths.length > 0) {
    const more =
      workspace.moreChangedPaths > 0 ? `\n- …and ${workspace.moreChangedPaths} more` : "";
    lines.push(
      `Uncommitted files:\n${workspace.changedPaths.map((path) => `- ${path}`).join("\n")}${more}`,
    );
  }
  return lines.length > 0 ? lines.join("\n\n") : null;
}

function renderQuestion(number: number, question: QuestionFormQuestion): string {
  const lines = [`Question ${number}: ${question.question.trim()}`];
  if (question.options.length > 0) {
    lines.push(
      `Options the developer can already pick: ${question.options
        .map((option) => option.label)
        .join(" | ")}`,
    );
  }
  return lines.join("\n");
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

const NEW_CHAT_CONTRACT = [
  "A developer has just opened an empty chat with a coding agent in the checkout",
  "described below, and has typed nothing yet. Write the first messages they are",
  `most likely to send: at least one, at most ${PROMPT_SUGGESTION_MAX_COUNT}, best guess first.`,
].join(" ");

const NEW_CHAT_RULES = [
  "Rules:",
  "- Write as the developer, addressing the agent: imperative, first person.",
  `- One line each, at most ${PROMPT_SUGGESTION_MAX_CHARS} characters, no numbering or quotes.`,
  "- Name something real from the branch, the commits or the changed files.",
  "- Only file names and commit subjects are given: never claim to know what the code does.",
  "- Propose work that fits what is unfinished here, not generic housekeeping.",
  "- No filler like 'help me' or 'what should I do': instruct, or ask something specific.",
  "- Write in the language the commit subjects are written in.",
].join("\n");

const QUESTION_CONTRACT = [
  "A coding agent has stopped to ask the developer a question, and the developer's",
  "answer box is empty. For each numbered question below, write the answers they are",
  `most likely to give to that question: at least one, at most ${PROMPT_SUGGESTION_MAX_COUNT},`,
  "best guess first, filed under that question's number.",
].join(" ");

const QUESTION_JSON_SHAPE =
  'Return JSON only: {"answers": [{"question": 1, "suggestions": ["...", "..."]}]}';

const QUESTION_RULES = [
  "Rules:",
  "- Answer each question as the developer would, in their own voice.",
  "- An answer goes under the number of the question it answers, never another.",
  `- One line each, at most ${PROMPT_SUGGESTION_MAX_CHARS} characters, no numbering or quotes.`,
  "- Each answer must be a different decision, not a rewording of the same one.",
  "- Repeat nothing the developer can already pick from the listed options.",
  "- Decide: no 'up to you', no restating the question, no asking a question back.",
  "- Write in the language the developer has been using.",
].join("\n");
