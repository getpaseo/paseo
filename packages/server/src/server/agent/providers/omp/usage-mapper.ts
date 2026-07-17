import type { AgentUsage } from "../../agent-sdk-types.js";
import type { OmpSessionState, OmpSessionStats } from "./rpc-types.js";

export function mapOmpUsage(input: {
  stats: OmpSessionStats;
  state: OmpSessionState;
  baseUsage: AgentUsage | undefined;
}): AgentUsage | undefined {
  const contextWindowUsedTokens = finiteNumber(input.state.contextUsage?.tokens);
  const contextWindowMaxTokens = finiteNumber(input.state.contextUsage?.contextWindow);
  if (contextWindowUsedTokens === undefined && contextWindowMaxTokens === undefined) {
    return input.baseUsage;
  }

  return {
    ...input.baseUsage,
    ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
    ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
  };
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
