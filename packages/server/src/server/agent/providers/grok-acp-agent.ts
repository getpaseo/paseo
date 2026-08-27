import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentStreamEvent, AgentUsage } from "../agent-sdk-types.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

const GROK_USD_TICKS_PER_DOLLAR = 10_000_000_000;
const GROK_SESSION_UPDATE_METHOD = "_x.ai/session/update";

const GrokTurnUsageSchema = z.object({
  inputTokens: z.number().finite().optional(),
  outputTokens: z.number().finite().optional(),
  cachedReadTokens: z.number().finite().optional(),
  costUsdTicks: z.number().finite().optional(),
});

const GrokSignalsSchema = z.object({
  contextTokensUsed: z.number().finite().optional(),
  contextWindowTokens: z.number().finite().optional(),
});

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
  grokHome?: string;
  readSignals?: (cwd: string, sessionId: string) => GrokContextUsage | null;
}

export interface GrokContextUsage {
  contextWindowUsedTokens: number;
  contextWindowMaxTokens: number;
}

interface GrokSessionUsageContext {
  sessionId: string | null;
  cwd: string;
  grokHome?: string;
  readSignals?: (cwd: string, sessionId: string) => GrokContextUsage | null;
  defaultContextWindow?: number | null;
}

interface GrokExtensionUsageContext {
  sessionId: string | null;
  cwd: string;
  provider: string;
  readSignals?: (cwd: string, sessionId: string) => GrokContextUsage | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function readGrokDefaultContextWindow(grokHome?: string): number | null {
  const raw = readJsonFileOrNull(join(grokHomeDir(grokHome), "models_cache.json"));
  if (!isRecord(raw) || !isRecord(raw.models)) return null;
  const preferred = isRecord(raw.models["grok-4.6"])
    ? raw.models["grok-4.6"]
    : Object.values(raw.models).find(isRecord);
  if (!preferred || !isRecord(preferred.info)) return null;
  const contextWindow = preferred.info["context_window"];
  return typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : null;
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

export function mapGrokTurnUsage(
  rawUsage: unknown,
  context: GrokContextUsage | null,
): AgentUsage | undefined {
  const parsed = GrokTurnUsageSchema.safeParse(rawUsage);
  const usage: AgentUsage = {};
  if (parsed.success) {
    if (parsed.data.inputTokens !== undefined) usage.inputTokens = parsed.data.inputTokens;
    if (parsed.data.outputTokens !== undefined) usage.outputTokens = parsed.data.outputTokens;
    if (parsed.data.cachedReadTokens !== undefined) {
      usage.cachedInputTokens = parsed.data.cachedReadTokens;
    }
    if (parsed.data.costUsdTicks !== undefined && parsed.data.costUsdTicks >= 0) {
      usage.totalCostUsd = parsed.data.costUsdTicks / GROK_USD_TICKS_PER_DOLLAR;
    }
  }
  if (context) {
    usage.contextWindowUsedTokens = context.contextWindowUsedTokens;
    usage.contextWindowMaxTokens = context.contextWindowMaxTokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function handleGrokExtensionNotification(
  method: string,
  params: Record<string, unknown>,
  context: GrokExtensionUsageContext,
): AgentStreamEvent[] {
  if (method !== GROK_SESSION_UPDATE_METHOD) return [];
  if (!isRecord(params.update)) return [];
  if (params.update["sessionUpdate"] !== "turn_completed") return [];

  const sessionId = typeof params.sessionId === "string" ? params.sessionId : context.sessionId;
  const signals =
    sessionId === null
      ? null
      : (context.readSignals ?? readGrokContextUsage)(context.cwd, sessionId);
  const usage = mapGrokTurnUsage(params.update["usage"], signals);
  if (!usage) return [];

  return [
    {
      type: "usage_updated",
      provider: context.provider,
      usage,
    },
  ];
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GrokACPAgentClientOptions) {
    const readSignals = options.readSignals;
    const grokHome = options.grokHome;
    const resolveSignals =
      readSignals ??
      ((cwd: string, sessionId: string) => readGrokContextUsage(cwd, sessionId, grokHome));
    const defaultContextWindow = readGrokDefaultContextWindow(grokHome);
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      extensionNotificationHandler: (method, params, context) =>
        handleGrokExtensionNotification(method, params, {
          ...context,
          readSignals: resolveSignals,
        }),
      sessionNotificationUsage: (params, context) =>
        grokUsageFromSessionNotification(params, {
          ...context,
          grokHome,
          readSignals: resolveSignals,
          defaultContextWindow,
        }),
    });
  }
}
