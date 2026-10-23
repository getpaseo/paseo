import type { z } from "zod";
import type { AgentPromptSuggestionsMessage, PromptSuggestion } from "@getpaseo/protocol/messages";
import {
  parseQuestionFormQuestions,
  type QuestionFormQuestion,
} from "@getpaseo/protocol/question-form";
import type { AgentPermissionRequest } from "../agent-sdk-types.js";
import type { AgentManager } from "../agent-manager.js";
import {
  buildPromptSuggestionPrompt,
  buildQuestionAnswerPrompt,
  type BuildPromptSuggestionPromptInput,
  type BuiltPromptSuggestionPrompt,
} from "./prompt.js";
import type { RepoRootResolver } from "../../../utils/build-metadata-prompt.js";
import {
  PROMPT_SUGGESTIONS_SCHEMA,
  PROMPT_SUGGESTIONS_SCHEMA_NAME,
  QUESTION_ANSWERS_SCHEMA,
  QUESTION_ANSWERS_SCHEMA_NAME,
  normalizeQuestionAnswers,
  normalizeSuggestions,
} from "./types.js";

export interface PromptSuggestionGeneration {
  generate<T>(request: {
    cwd: string;
    prompt: string;
    schema: z.ZodType<T>;
    schemaName: string;
    agentTitle: string;
    configKey?: "promptSuggestions";
    currentSelection?: { provider?: string | null; model?: string | null };
  }): Promise<T>;
}

interface LoggerLike {
  debug(...args: unknown[]): void;
}

export interface PromptSuggestionServiceOptions {
  agents: Pick<AgentManager, "subscribe" | "getAgent" | "getTimeline">;
  generation: PromptSuggestionGeneration;
  emit: (message: AgentPromptSuggestionsMessage) => void;
  isEnabled: () => boolean;
  logger: LoggerLike;
  // Lets paseo.json steer the suggestion wording, the same way it steers every
  // other metadata prompt; absent, the built-in rules stand.
  workspaceGitService?: RepoRootResolver;
  hasListeners?: () => boolean;
  debounceMs?: number;
  maxConcurrent?: number;
  now?: () => Date;
}

interface PendingQuestion {
  permissionId: string;
  questions: QuestionFormQuestion[];
}

interface PreparedPrompt {
  built: BuiltPromptSuggestionPrompt;
  // Set for a question: the prompt number of each answerable question, to its card index.
  answerable: ReadonlyMap<number, number> | null;
  configKey: "promptSuggestions";
}

interface CachedSuggestions {
  payload: AgentPromptSuggestionsMessage["payload"];
  timelineLength: number;
}

interface AgentEntry {
  timer: ReturnType<typeof setTimeout> | null;
  // A turn that lands while this agent is generating waits here; dropping it
  // would lose the newer turn's suggestion entirely.
  requeue: boolean;
  // Bumped at every turn boundary; a generation whose token no longer matches
  // lost its race and its result is dropped.
  token: number;
  generating: boolean;
}

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_MAX_CONCURRENT = 2;

export class PromptSuggestionService {
  private readonly options: PromptSuggestionServiceOptions;
  private readonly entries = new Map<string, AgentEntry>();
  private readonly lastEmitted = new Map<string, CachedSuggestions>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly queue: string[] = [];
  private unsubscribe: (() => void) | null = null;
  private inFlight = 0;

  constructor(options: PromptSuggestionServiceOptions) {
    this.options = options;
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.options.agents.subscribe(
      (event) => {
        if (event.type !== "agent_stream") {
          return;
        }
        switch (event.event.type) {
          case "turn_completed":
            this.schedule(event.agentId);
            break;
          case "permission_requested":
            this.scheduleQuestion(event.agentId, event.event.request);
            break;
          case "permission_resolved":
            this.pendingQuestions.delete(event.agentId);
            break;
          case "turn_started":
          case "turn_failed":
          case "turn_canceled":
            this.cancel(event.agentId);
            break;
          default:
            break;
        }
      },
      { replayState: false },
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const agentId of this.entries.keys()) {
      this.cancel(agentId);
    }
    this.entries.clear();
    this.lastEmitted.clear();
    this.pendingQuestions.clear();
    this.queue.length = 0;
  }

  /**
   * Answer a client that opened a chat and holds no suggestion for it. A cached
   * payload is re-emitted when the conversation has not moved since; otherwise
   * this queues a generation and the usual event carries the result.
   */
  requestFor(agentId: string): { accepted: boolean; error?: string } {
    if (!this.options.isEnabled()) {
      return { accepted: false, error: "Prompt suggestions are turned off for this host." };
    }
    const agent = this.options.agents.getAgent(agentId);
    if (!agent || agent.internal) {
      return { accepted: false, error: "Unknown agent." };
    }

    const cached = this.lastEmitted.get(agentId);
    const pendingPermissionId = this.pendingQuestions.get(agentId)?.permissionId;
    const cacheMatchesQuestion = cached?.payload.answersPermissionId === pendingPermissionId;
    if (
      cached &&
      cacheMatchesQuestion &&
      cached.timelineLength === this.options.agents.getTimeline(agentId).length
    ) {
      this.options.emit({ type: "agent_prompt_suggestions", payload: cached.payload });
      return { accepted: true };
    }

    const entry = this.entryFor(agentId);
    if (entry.generating || entry.timer || this.queue.includes(agentId)) {
      return { accepted: true };
    }
    entry.token += 1;
    this.enqueue(agentId);
    return { accepted: true };
  }

  private entryFor(agentId: string): AgentEntry {
    const existing = this.entries.get(agentId);
    if (existing) {
      return existing;
    }
    const created: AgentEntry = { timer: null, token: 0, generating: false, requeue: false };
    this.entries.set(agentId, created);
    return created;
  }

  private cancel(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.token += 1;
    entry.requeue = false;
    this.lastEmitted.delete(agentId);
    const queued = this.queue.indexOf(agentId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
    }
  }

  // Only a question: a tool or plan approval is a decision to read, and a guess
  // next to it would be a nudge to approve something unread.
  private scheduleQuestion(agentId: string, request: AgentPermissionRequest): void {
    if (request.kind !== "question") {
      return;
    }
    const questions = parseQuestionFormQuestions(request.input);
    if (!questions) {
      return;
    }
    this.pendingQuestions.set(agentId, { permissionId: request.id, questions });
    this.schedule(agentId);
  }

  private schedule(agentId: string): void {
    if (!this.shouldGenerate(agentId)) {
      return;
    }
    const entry = this.entryFor(agentId);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.token += 1;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.enqueue(agentId);
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    (entry.timer as unknown as { unref?: () => void }).unref?.();
  }

  private enqueue(agentId: string): void {
    if (this.queue.includes(agentId)) {
      return;
    }
    this.queue.push(agentId);
    this.drain();
  }

  private drain(): void {
    const max = this.options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    while (this.inFlight < max && this.queue.length > 0) {
      const agentId = this.queue.shift();
      if (!agentId) {
        return;
      }
      const entry = this.entries.get(agentId);
      if (!entry) {
        continue;
      }
      if (entry.generating) {
        entry.requeue = true;
        continue;
      }
      void this.generate(agentId, entry);
    }
  }

  private shouldGenerate(agentId: string): boolean {
    if (!this.options.isEnabled()) {
      return false;
    }
    if (this.options.hasListeners && !this.options.hasListeners()) {
      return false;
    }
    const agent = this.options.agents.getAgent(agentId);
    return Boolean(agent) && !agent?.internal;
  }

  private async preparePrompt(
    common: BuildPromptSuggestionPromptInput & { agentTitle: string | null; cwd: string },
    question: PendingQuestion | undefined,
  ): Promise<PreparedPrompt | null> {
    if (question) {
      const built = await buildQuestionAnswerPrompt({ ...common, questions: question.questions });
      return built ? { built, answerable: built.answerable, configKey: "promptSuggestions" } : null;
    }
    const built = await buildPromptSuggestionPrompt(common);
    return built ? { built, answerable: null, configKey: "promptSuggestions" } : null;
  }

  // A question's drafts come back filed by question, so each can be tagged with it.
  private async requestSuggestions(
    prepared: PreparedPrompt,
    request: Omit<Parameters<PromptSuggestionGeneration["generate"]>[0], "schema" | "schemaName">,
  ): Promise<PromptSuggestion[]> {
    if (prepared.answerable) {
      const response = await this.options.generation.generate({
        ...request,
        schema: QUESTION_ANSWERS_SCHEMA,
        schemaName: QUESTION_ANSWERS_SCHEMA_NAME,
      });
      return normalizeQuestionAnswers(response.answers, prepared.answerable);
    }
    const response = await this.options.generation.generate({
      ...request,
      schema: PROMPT_SUGGESTIONS_SCHEMA,
      schemaName: PROMPT_SUGGESTIONS_SCHEMA_NAME,
    });
    return normalizeSuggestions(response.suggestions);
  }

  private async generate(agentId: string, entry: AgentEntry): Promise<void> {
    const token = entry.token;
    if (!this.shouldGenerate(agentId)) {
      return;
    }
    const agent = this.options.agents.getAgent(agentId);
    if (!agent) {
      return;
    }

    const timeline = this.options.agents.getTimeline(agentId);
    const timelineLengthAtBuild = timeline.length;
    const question = this.pendingQuestions.get(agentId);
    let prepared: PreparedPrompt | null;
    try {
      prepared = await this.preparePrompt(
        {
          timeline,
          agentTitle: agent.config?.title ?? null,
          cwd: agent.cwd,
          workspaceGitService: this.options.workspaceGitService,
        },
        question,
      );
    } catch (error) {
      this.options.logger.debug({ err: error, agentId }, "prompt suggestions: timeline unreadable");
      return;
    }
    if (!prepared) {
      return;
    }

    entry.generating = true;
    this.inFlight += 1;
    try {
      const suggestions = await this.requestSuggestions(prepared, {
        cwd: agent.cwd,
        prompt: prepared.built.prompt,
        agentTitle: "Prompt suggestions",
        configKey: prepared.configKey,
        // When the metadata chain has nothing usable, fall back to the agent's own
        // model: it has already seen this conversation, so nothing new leaves.
        currentSelection: { provider: agent.provider, model: agent.config?.model ?? null },
      });
      if (entry.token !== token) {
        return;
      }
      if (suggestions.length === 0) {
        return;
      }
      const payload = {
        agentId,
        turnSeq: token,
        suggestions,
        generatedAt: (this.options.now?.() ?? new Date()).toISOString(),
        ...(question ? { answersPermissionId: question.permissionId } : {}),
      };
      // Kept so a client that opens this chat later can be answered without
      // spending a second call on a conversation that has not moved.
      this.lastEmitted.set(agentId, { payload, timelineLength: timelineLengthAtBuild });
      this.options.emit({ type: "agent_prompt_suggestions", payload });
    } catch (error) {
      // A guess that did not arrive is not an event the user needs to know about.
      this.options.logger.debug({ err: error, agentId }, "prompt suggestions: generation failed");
    } finally {
      entry.generating = false;
      this.inFlight -= 1;
      if (entry.requeue) {
        entry.requeue = false;
        this.queue.push(agentId);
      }
      this.drain();
    }
  }
}
