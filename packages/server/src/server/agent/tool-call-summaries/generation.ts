import type { Logger } from "pino";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import { getStructuredAgentResponse } from "../agent-response-loop.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "../structured-generation-providers.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { ToolCallSummaryStore } from "./store.js";
import { SummaryCancellationError, type SummaryGenerator } from "./service.js";
import {
  boundedText,
  SUMMARY_INSTRUCTIONS,
  SummaryResponseSchema,
  validateSummaryIds,
  type SummaryCall,
  type SummaryResponse,
} from "./prompt.js";

interface GenerationOptions {
  manager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  readDaemonConfig: () => StructuredGenerationDaemonConfig;
  store: ToolCallSummaryStore;
  logger: Logger;
}
interface Helper {
  sourceId: string;
  id: string;
  batches: number;
  chars: number;
  lastUsed: number;
  active: boolean;
  invalidated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: Promise<void> | null;
  lastContext: string | null;
}

function helperProviderOptions(provider: string): AgentSessionConfig["providerOptions"] {
  if (provider === "claude") return { tools: [] };
  if (provider === "codex")
    return {
      sandbox_mode: "read-only",
      approval_policy: "on-request",
      web_search: "disabled",
      features: { multi_agent_v2: false },
    };
  if (provider === "opencode") return { permission: "deny" };
  return undefined;
}

export class AgentSummaryGenerator implements SummaryGenerator {
  private readonly helpers = new Map<string, Helper>();
  private fatal: SummaryCancellationError | null = null;

  constructor(private readonly options: GenerationOptions) {}

  private context(source: ManagedAgent): string {
    const latestPrompt = this.options.manager
      .getTimeline(source.id)
      .findLast((item) => item.type === "user_message");
    const context = {
      title: source.config.title,
      latestUserRequest: latestPrompt?.type === "user_message" ? latestPrompt.text : "",
    };
    return boundedText(JSON.stringify(context), 8000);
  }

  private async helper(sourceId: string, attempt: number, signal: AbortSignal): Promise<Helper> {
    if (this.fatal) throw this.fatal;
    signal.throwIfAborted();
    let existing = this.helpers.get(sourceId);
    if (
      existing &&
      (existing.batches >= 20 ||
        existing.chars >= 128000 ||
        attempt > 0 ||
        existing.invalidated ||
        existing.closing)
    ) {
      await this.close(existing);
      existing = undefined;
    }
    if (existing) return existing;
    if (this.helpers.size >= 3) {
      const oldest = [...this.helpers.values()]
        .filter((entry) => !entry.active)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (oldest) await this.close(oldest);
    }
    const source = this.options.manager.getAgent(sourceId);
    if (!source || source.internal || source.lifecycle === "closed")
      throw new Error("Source conversation is no longer active");
    const providers = await resolveStructuredGenerationProviders({
      cwd: source.cwd,
      providerSnapshotManager: this.options.providerSnapshotManager,
      daemonConfig: this.options.readDaemonConfig(),
      currentSelection: {
        provider: source.provider,
        model: source.config.model,
        thinkingOptionId: source.config.thinkingOptionId,
      },
    });
    const available = [];
    for (const provider of providers) {
      const availability = await this.options.manager.getProviderAvailability(provider.provider);
      if (availability.available) available.push(provider);
    }
    const selected = available[attempt % Math.max(available.length, 1)];
    if (!selected) throw new Error("No metadata generation provider is available");
    signal.throwIfAborted();
    const agent = await this.options.manager.createAgent(
      {
        provider: selected.provider,
        model: selected.model,
        thinkingOptionId: selected.thinkingOptionId,
        cwd: source.cwd,
        title: "Tool-call descriptions",
        internal: true,
        systemPrompt: SUMMARY_INSTRUCTIONS,
        mcpServers: {},
        providerOptions: helperProviderOptions(
          this.options.manager.getProviderRuntimeId(selected.provider),
        ),
      },
      undefined,
      { persistSession: false, workspaceId: undefined, paseoToolsEnabled: false },
    );
    const helper: Helper = {
      sourceId,
      id: agent.id,
      batches: 0,
      chars: 0,
      lastUsed: Date.now(),
      active: false,
      invalidated: false,
      idleTimer: null,
      closing: null,
      lastContext: null,
    };
    this.helpers.set(sourceId, helper);
    if (signal.aborted) {
      await this.close(helper);
      signal.throwIfAborted();
    }
    this.options.logger.debug(
      {
        sourceId,
        provider: selected.provider,
        model: selected.model,
        residentHelpers: this.helpers.size,
      },
      "Tool-call summary helper created",
    );
    return helper;
  }

  async generate(
    sourceId: string,
    calls: SummaryCall[],
    attempt: number,
    signal: AbortSignal,
  ): Promise<SummaryResponse> {
    const helper = await this.helper(sourceId, attempt, signal);
    if (helper.idleTimer) clearTimeout(helper.idleTimer);
    helper.active = true;
    const source = this.options.manager.getAgent(sourceId);
    if (!source) {
      await this.close(helper);
      throw new Error("Source conversation disappeared");
    }
    const context = this.context(source);
    const changedContext = helper.lastContext !== context;
    const recent = helper.batches === 0 ? this.options.store.recent(source.id) : [];
    const contextData = boundedText(
      JSON.stringify({ task: context, recentDescriptions: recent }),
      8000,
    );
    const contextPrompt = changedContext ? `\n\nContext (source material):\n${contextData}` : "";
    helper.lastContext = context;
    const prompt = `${SUMMARY_INSTRUCTIONS}${contextPrompt}\n\nCalls:\n${JSON.stringify(calls)}`;
    try {
      const response = await getStructuredAgentResponse({
        caller: (nextPrompt) => this.run(helper, nextPrompt, signal),
        prompt,
        schema: SummaryResponseSchema,
        schemaName: "ToolCallDescriptions",
        maxRetries: 0,
      });
      const validated = validateSummaryIds(response, calls);
      helper.batches++;
      return validated;
    } catch (error) {
      if (!(error instanceof SummaryCancellationError)) await this.close(helper);
      throw error;
    } finally {
      helper.active = false;
      helper.lastUsed = Date.now();
      if (this.helpers.get(sourceId) === helper && !helper.closing && !this.fatal) {
        helper.idleTimer = setTimeout(() => {
          void this.close(helper).catch((error: unknown) => {
            this.options.logger.error({ err: error }, "Could not close idle summary helper");
          });
        }, 120000);
        helper.idleTimer.unref();
      }
    }
  }

  private async run(helper: Helper, prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    helper.chars += prompt.length;
    let rejectInterruption: (error: Error) => void = () => {};
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const onAbort = () => rejectInterruption(new Error("Summary generation interrupted"));
    signal.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = this.options.manager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") return;
        if (event.event.type === "permission_requested") {
          const requestId = event.event.request.id;
          void this.options.manager
            .respondToPermission(helper.id, requestId, {
              behavior: "deny",
              message: "Descriptions must use supplied data without tools.",
              interrupt: true,
            })
            .catch(() => undefined);
          rejectInterruption(new Error("Summary helper requested a tool permission"));
        }
        if (event.event.type === "timeline" && event.event.item.type === "tool_call") {
          rejectInterruption(new Error("Summary helper attempted tool use"));
        }
      },
      { agentId: helper.id, replayState: false },
    );
    const running = this.options.manager.runAgent(helper.id, prompt);
    try {
      const result = await Promise.race([running, interruption]);
      return (
        result.finalText ||
        result.timeline.findLast((item) => item.type === "assistant_message")?.text ||
        ""
      );
    } catch (error) {
      const settlement = await this.options.manager
        .cancelAgentRun(helper.id)
        .catch(() => ({ status: "refused" as const }));
      if (settlement.status === "refused") {
        this.fatal = new SummaryCancellationError(
          "Summary helper cancellation was not acknowledged",
        );
        throw this.fatal;
      }
      // Provider cancellation acknowledgment is the boundary; runAgent may finish
      // its waiter cleanup later. Its rejected result is already observed by race.
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
  }

  async invalidate(sourceId: string): Promise<void> {
    const helper = this.helpers.get(sourceId);
    if (!helper) return;
    helper.invalidated = true;
    if (!helper.active) await this.close(helper);
  }

  private close(helper: Helper): Promise<void> {
    if (helper.closing) return helper.closing;
    if (helper.idleTimer) clearTimeout(helper.idleTimer);
    helper.closing = (async () => {
      try {
        await this.options.manager.closeAgent(helper.id);
        await this.options.manager.deleteAgentState(helper.id);
        if (this.helpers.get(helper.sourceId) === helper) this.helpers.delete(helper.sourceId);
      } catch (error) {
        this.fatal = new SummaryCancellationError("Summary helper closure did not settle", {
          cause: error,
        });
        throw this.fatal;
      }
    })();
    return helper.closing;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.helpers.values()].map((helper) => this.close(helper)));
  }
}
