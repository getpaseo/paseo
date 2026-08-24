import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentSessionConfig, AgentUsage } from "../agent-sdk-types.js";
import { ACPAgentSession, type ACPAgentSessionOptions } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

const GrokModelsCacheSchema = z
  .object({
    models: z.record(
      z.string(),
      z
        .object({
          info: z
            .object({
              context_window: z.number().finite().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

function readJsonFileOrNull(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function grokHomeDir(): string {
  return process.env["GROK_HOME"] || join(homedir(), ".grok");
}

function positiveContextWindow(value: number | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

export function readGrokDefaultContextWindow(grokHome = grokHomeDir()): number | null {
  const parsed = GrokModelsCacheSchema.safeParse(
    readJsonFileOrNull(join(grokHome, "models_cache.json")),
  );
  if (!parsed.success) return null;

  for (const model of Object.values(parsed.data.models)) {
    const window = positiveContextWindow(model.info?.context_window);
    if (window !== null) return window;
  }
  return null;
}

export function grokUsageFromSessionNotification(
  params: SessionNotification,
  defaultContextWindow: number | null,
): AgentUsage | undefined {
  const totalTokens = params._meta?.["totalTokens"];
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return undefined;
  }

  const usage: AgentUsage = {
    contextWindowUsedTokens: totalTokens,
  };
  if (defaultContextWindow !== null) {
    usage.contextWindowMaxTokens = defaultContextWindow;
  }
  return usage;
}

export class GrokACPAgentSession extends ACPAgentSession {
  private lastUsedTokens: number | null = null;
  private lastMaxTokens: number | null = null;

  constructor(
    config: AgentSessionConfig,
    options: ACPAgentSessionOptions,
    private readonly defaultContextWindow: number | null,
  ) {
    super(config, options);
  }

  override async sessionUpdate(params: SessionNotification): Promise<void> {
    await super.sessionUpdate(params);
    if (this.id === null || params.sessionId !== this.id) {
      return;
    }

    const usage = grokUsageFromSessionNotification(params, this.defaultContextWindow);
    if (!usage) return;

    const used = usage.contextWindowUsedTokens ?? null;
    const max = usage.contextWindowMaxTokens ?? null;
    if (used === this.lastUsedTokens && max === this.lastMaxTokens) {
      return;
    }
    this.lastUsedTokens = used;
    this.lastMaxTokens = max;
    this.pushEvent({
      type: "usage_updated",
      provider: this.provider,
      usage,
    });
  }
}

// Grok publishes live context-window tokens on session/update `_meta.totalTokens`
// rather than ACP `usage_update`. Reuse the shared session and emit the existing
// usage_updated event.
export class GrokACPAgentClient extends GenericACPAgentClient {
  private readonly defaultContextWindow: number | null;

  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId ?? "grok",
      label: options.label ?? "Grok",
      providerParams: options.providerParams,
    });
    this.defaultContextWindow = readGrokDefaultContextWindow();
  }

  protected override createAgentSession(
    config: AgentSessionConfig,
    options: ACPAgentSessionOptions,
  ): ACPAgentSession {
    return new GrokACPAgentSession(config, options, this.defaultContextWindow);
  }
}
