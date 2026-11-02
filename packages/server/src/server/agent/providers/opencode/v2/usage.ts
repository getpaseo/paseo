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

export class SessionUsage {
  private readonly limits = new Map<string, Promise<number | undefined>>();
  private reports: Promise<void> = Promise.resolve();
  constructor(private readonly options: UsageOptions) {}
  observe(event: OpenCodeEvent) {
    if (event.type !== "session.step.ended") return;
    const { tokens } = event.data;
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
