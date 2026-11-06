import type { ModelRef, OpenCodeEvent, SessionInfo, TokenUsageInfo } from "@opencode/client";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import type { V2Api } from "./api.js";
import { usageFromV2 } from "./mapping.js";

interface UsageOptions {
  client(): V2Api;
  cwd: string;
  info(): SessionInfo;
  emit(event: AgentStreamEvent): void;
  reportError(error: unknown): void;
}

// A step is one model call, so its tokens are the context that call used.
function contextWindowUsedTokens(tokens: TokenUsageInfo) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

function isZeroUsage(tokens: TokenUsageInfo) {
  return (
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.reasoning === 0 &&
    tokens.cache.read === 0 &&
    tokens.cache.write === 0
  );
}

// session.usage.updated carries cumulative session totals; the context of the
// step that just ended is the delta against the previous snapshot.
function tokenDelta(current: TokenUsageInfo, previous: TokenUsageInfo): TokenUsageInfo {
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
    cache: {
      read: Math.max(0, current.cache.read - previous.cache.read),
      write: Math.max(0, current.cache.write - previous.cache.write),
    },
  };
}

export class SessionUsage {
  private readonly limits = new Map<string, Promise<number | undefined>>();
  private reports: Promise<void> = Promise.resolve();
  private cumulative: TokenUsageInfo | null = null;
  constructor(private readonly options: UsageOptions) {}
  observe(event: OpenCodeEvent) {
    if (event.type === "session.step.ended") {
      // Older servers attach per-step tokens to session.step.ended directly.
      this.queue(event.data.tokens);
      return;
    }
    if (event.type === "session.usage.updated") {
      const previous = this.cumulative;
      this.cumulative = event.data.tokens;
      // Without a baseline the per-step delta is unknowable; servers that emit
      // session.usage.updated also emit session.step.ended, which covers this
      // step, so skipping the first snapshot keeps the meter honest.
      if (!previous) return;
      this.queue(tokenDelta(event.data.tokens, previous));
    }
  }
  private queue(tokens: TokenUsageInfo) {
    if (isZeroUsage(tokens)) return;
    // Reports stay in step order while a model's context limit is still being looked up.
    this.reports = this.reports
      .then(() => this.report(tokens))
      .catch((error: unknown) => this.options.reportError(error));
  }
  private async report(tokens: TokenUsageInfo) {
    const model = this.options.info().model;
    const contextWindowMaxTokens = model ? await this.contextLimit(model) : undefined;
    this.options.emit({
      type: "usage_updated",
      provider: "opencode",
      usage: {
        ...usageFromV2(this.options.info()),
        contextWindowUsedTokens: contextWindowUsedTokens(tokens),
        ...(contextWindowMaxTokens === undefined ? {} : { contextWindowMaxTokens }),
      },
    });
  }
  private contextLimit(model: ModelRef) {
    const key = `${model.providerID}/${model.id}`;
    const cached = this.limits.get(key);
    if (cached) return cached;
    const limit = this.options
      .client()
      .model.list({ location: { directory: this.options.cwd } })
      .then(
        (catalog) =>
          catalog.data.find(
            (entry) => entry.providerID === model.providerID && entry.id === model.id,
          )?.limit.context,
      );
    this.limits.set(key, limit);
    limit.catch(() => this.limits.delete(key));
    return limit;
  }
}
