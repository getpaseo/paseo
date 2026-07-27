import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { expandTilde } from "../../../utils/path.js";
import type { ACPContextUsageResolver } from "./acp-agent.js";

const GROK_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GrokSessionSignals {
  contextTokensUsed: number;
  contextWindowTokens: number;
}

interface GrokContextUsageResolverOptions {
  env?: Record<string, string>;
  readSessionSignals?: (sessionId: string, cwd: string) => GrokSessionSignals | null;
}

function parseNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parsePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function resolveGrokHome(env: Record<string, string> | undefined): string {
  const configuredHome = env?.GROK_HOME ?? process.env.GROK_HOME;
  return configuredHome ? resolve(expandTilde(configuredHome)) : join(homedir(), ".grok");
}

function createGrokSessionSignalsReader(
  env: Record<string, string> | undefined,
): (sessionId: string, cwd: string) => GrokSessionSignals | null {
  const grokHome = resolveGrokHome(env);
  return (sessionId, cwd) => {
    if (!GROK_SESSION_ID_PATTERN.test(sessionId)) return null;

    const signalsPath = join(
      grokHome,
      "sessions",
      encodeURIComponent(cwd),
      sessionId,
      "signals.json",
    );
    if (!existsSync(signalsPath)) return null;

    const parsed = JSON.parse(readFileSync(signalsPath, "utf8")) as Record<string, unknown>;
    const contextTokensUsed = parseNonNegativeNumber(parsed.contextTokensUsed);
    const contextWindowTokens = parsePositiveNumber(parsed.contextWindowTokens);
    if (contextTokensUsed === null || contextWindowTokens === null) return null;
    return { contextTokensUsed, contextWindowTokens };
  };
}

/**
 * Grok's ACP transport may omit usage updates. Its local session signals are
 * the CLI's own context counters, so use them before falling back to unknown.
 */
export function createGrokContextUsageResolver(
  options: GrokContextUsageResolverOptions = {},
): ACPContextUsageResolver {
  const readSessionSignals =
    options.readSessionSignals ?? createGrokSessionSignalsReader(options.env);

  return ({ sessionId, cwd, usage }) => {
    if (
      usage?.contextWindowMaxTokens !== undefined &&
      usage.contextWindowUsedTokens !== undefined
    ) {
      return usage;
    }

    try {
      const signals = readSessionSignals(sessionId, cwd);
      if (!signals) return usage;
      return {
        ...usage,
        contextWindowMaxTokens: signals.contextWindowTokens,
        contextWindowUsedTokens: signals.contextTokensUsed,
      };
    } catch {
      return usage;
    }
  };
}
