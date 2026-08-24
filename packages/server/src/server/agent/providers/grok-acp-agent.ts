import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentUsage } from "../agent-sdk-types.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

const GrokSignalsSchema = z.object({
  contextTokensUsed: z.number().finite().optional(),
  contextWindowTokens: z.number().finite().optional(),
});

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

export interface GrokContextUsage {
  contextWindowUsedTokens: number;
  contextWindowMaxTokens: number;
}

interface GrokSessionUsageContext {
  sessionId: string | null;
  cwd: string;
  readSignals?: (cwd: string, sessionId: string) => GrokContextUsage | null;
  defaultContextWindow?: number | null;
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

function grokHomeDir(grokHome?: string): string {
  return grokHome || process.env["GROK_HOME"] || join(homedir(), ".grok");
}

export function grokSessionSignalsPath(cwd: string, sessionId: string, grokHome?: string): string {
  return join(
    grokHomeDir(grokHome),
    "sessions",
    encodeURIComponent(cwd),
    sessionId,
    "signals.json",
  );
}

function positiveContextWindow(value: number | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

export function readGrokDefaultContextWindow(grokHome?: string): number | null {
  const parsed = GrokModelsCacheSchema.safeParse(
    readJsonFileOrNull(join(grokHomeDir(grokHome), "models_cache.json")),
  );
  if (!parsed.success) return null;

  // Prefer the current default model so a leftover older cache entry does not
  // set a stale window size.
  const preferredWindow = positiveContextWindow(
    parsed.data.models["grok-4.6"]?.info?.context_window,
  );
  if (preferredWindow !== null) return preferredWindow;

  for (const model of Object.values(parsed.data.models)) {
    const window = positiveContextWindow(model.info?.context_window);
    if (window !== null) return window;
  }
  return null;
}

export function grokUsageFromSessionNotification(
  params: SessionNotification,
  context: GrokSessionUsageContext,
): AgentUsage | undefined {
  const totalTokens = params._meta?.["totalTokens"];
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return undefined;
  }

  const sessionId = params.sessionId || context.sessionId;
  const signals =
    sessionId === null || sessionId.length === 0
      ? null
      : (context.readSignals ?? readGrokContextUsage)(context.cwd, sessionId);
  const maxTokens = signals?.contextWindowMaxTokens ?? context.defaultContextWindow ?? null;
  const usage: AgentUsage = {
    contextWindowUsedTokens: totalTokens,
  };
  if (maxTokens !== null) {
    usage.contextWindowMaxTokens = maxTokens;
  }
  return usage;
}

export function readGrokContextUsage(
  cwd: string,
  sessionId: string,
  grokHome?: string,
): GrokContextUsage | null {
  const parsed = GrokSignalsSchema.safeParse(
    readJsonFileOrNull(grokSessionSignalsPath(cwd, sessionId, grokHome)),
  );
  if (!parsed.success) return null;
  const used = parsed.data.contextTokensUsed;
  const max = parsed.data.contextWindowTokens;
  if (typeof used !== "number" || used < 0 || typeof max !== "number" || max <= 0) {
    return null;
  }
  return { contextWindowUsedTokens: used, contextWindowMaxTokens: max };
}

// Grok is a catalog ACP provider, but it publishes live context-window tokens
// on session/update `_meta.totalTokens` rather than ACP `usage_update`.
export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    const defaultContextWindow = readGrokDefaultContextWindow();
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId ?? "grok",
      label: options.label ?? "Grok",
      providerParams: options.providerParams,
      sessionNotificationUsage: (params, context) =>
        grokUsageFromSessionNotification(params, {
          ...context,
          defaultContextWindow,
        }),
    });
  }
}
