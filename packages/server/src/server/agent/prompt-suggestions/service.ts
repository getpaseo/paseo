import type { AgentPromptSuggestionsMessage } from "@getpaseo/protocol/messages";
import type { AgentManager } from "../agent-manager.js";
import { buildPromptSuggestionPrompt } from "./prompt.js";
import type { RepoRootResolver } from "../../../utils/build-metadata-prompt.js";
import {
  PROMPT_SUGGESTIONS_SCHEMA,
  PROMPT_SUGGESTIONS_SCHEMA_NAME,
  normalizeSuggestions,
  type PromptSuggestionsResponse,
} from "./types.js";

export interface PromptSuggestionGeneration {
  generate(request: {
    cwd: string;
    prompt: string;
    schema: typeof PROMPT_SUGGESTIONS_SCHEMA;
    schemaName: string;
    agentTitle: string;
    configKey?: "promptSuggestions";
    currentSelection?: { provider?: string | null; model?: string | null };
  }): Promise<PromptSuggestionsResponse>;
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
    this.queue.length = 0;
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
    const queued = this.queue.indexOf(agentId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
    }
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

  private async generate(agentId: string, entry: AgentEntry): Promise<void> {
    const token = entry.token;
    if (!this.shouldGenerate(agentId)) {
      return;
    }
    const agent = this.options.agents.getAgent(agentId);
    if (!agent) {
      return;
    }

    let built: Awaited<ReturnType<typeof buildPromptSuggestionPrompt>>;
    try {
      built = await buildPromptSuggestionPrompt({
        timeline: this.options.agents.getTimeline(agentId),
        agentTitle: agent.config?.title ?? null,
        cwd: agent.cwd,
        workspaceGitService: this.options.workspaceGitService,
      });
    } catch (error) {
      this.options.logger.debug({ err: error, agentId }, "prompt suggestions: timeline unreadable");
      return;
    }
    if (!built) {
      return;
    }

    entry.generating = true;
    this.inFlight += 1;
    try {
      const response = await this.options.generation.generate({
        cwd: agent.cwd,
        prompt: built.prompt,
        schema: PROMPT_SUGGESTIONS_SCHEMA,
        schemaName: PROMPT_SUGGESTIONS_SCHEMA_NAME,
        agentTitle: "Prompt suggestions",
        configKey: "promptSuggestions",
        // When the metadata chain has nothing usable, fall back to the agent's own
        // model: it has already seen this conversation, so nothing new leaves.
        currentSelection: { provider: agent.provider, model: agent.config?.model ?? null },
      });
      if (entry.token !== token) {
        return;
      }
      const suggestions = normalizeSuggestions(response.suggestions);
      if (suggestions.length === 0) {
        return;
      }
      this.options.emit({
        type: "agent_prompt_suggestions",
        payload: {
          agentId,
          turnSeq: token,
          suggestions,
          generatedAt: (this.options.now?.() ?? new Date()).toISOString(),
        },
      });
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
