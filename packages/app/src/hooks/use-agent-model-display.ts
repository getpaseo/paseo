import { useMemo } from "react";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import {
  resolveAgentModelDisplay,
  type AgentModelDisplay,
  type AgentModelDisplaySource,
} from "@/composer/agent-controls/utils";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";

/**
 * Resolves what an agent is running into display labels. Model labels only exist
 * in the providers snapshot, so every read-only surface that wants them has to go
 * through the snapshot query; keep the `cwd` identical to the one the composer's
 * agent controls use so all of them share a single cached query.
 */
export type AgentModelDisplayResolver = (input: {
  provider: string | null | undefined;
  source: AgentModelDisplaySource | null | undefined;
  thinkingFallback?: "model-default" | "none";
}) => AgentModelDisplay;

export function useAgentModelDisplayResolver(
  serverId: string | null,
  cwd: string | null | undefined,
): AgentModelDisplayResolver {
  const { entries } = useProvidersSnapshot(serverId, { cwd });

  return useMemo(() => {
    return ({ provider, source, thinkingFallback }) => {
      const models: AgentModelDefinition[] | null = provider
        ? (entries?.find((entry) => entry.provider === provider)?.models ?? null)
        : null;
      return resolveAgentModelDisplay({
        models,
        source,
        ...(thinkingFallback ? { thinkingFallback } : {}),
      });
    };
  }, [entries]);
}

export interface UseAgentModelDisplayInput extends AgentModelDisplaySource {
  serverId: string | null;
  cwd: string | null | undefined;
  provider: string | null | undefined;
}

/**
 * Single-agent form of {@link useAgentModelDisplayResolver}. Takes primitives
 * rather than an agent object so callers can pass store slices without having to
 * memoize a wrapper object first.
 */
export function useAgentModelDisplay(input: UseAgentModelDisplayInput): AgentModelDisplay {
  const resolve = useAgentModelDisplayResolver(input.serverId, input.cwd);
  const { provider, model, runtimeModelId, thinkingOptionId, effectiveThinkingOptionId } = input;

  return useMemo(
    () =>
      resolve({
        provider,
        // Pass effectiveThinkingOptionId straight through: `undefined` (daemon never
        // sent it) and `null` (runtime reported none) resolve differently downstream.
        source: { model, runtimeModelId, thinkingOptionId, effectiveThinkingOptionId },
      }),
    [effectiveThinkingOptionId, model, provider, resolve, runtimeModelId, thinkingOptionId],
  );
}
