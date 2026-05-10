import { z } from "zod";
import type { Logger } from "pino";

import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent, WaitForAgentResult } from "./agent-manager.js";
import { curateAgentActivity } from "./activity-curator.js";
import { selectItemsByProjectedLimit } from "./timeline-projection.js";
import type { AgentStorage } from "./agent-storage.js";
import { serializeAgentSnapshot } from "../messages.js";
import { StoredScheduleSchema } from "../schedule/types.js";
import type { AgentProvider } from "./agent-sdk-types.js";

export const AgentProviderEnum = z.string();

export const AgentStatusEnum = z.enum(["initializing", "idle", "running", "error", "closed"]);

export const ProviderModeSchema = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    icon: z.string().nullish(),
    colorTier: z.string().nullish(),
  })
  .passthrough();

export const ProviderSummarySchema = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    enabled: z.boolean().optional().default(true),
    modes: z.array(ProviderModeSchema).nullish(),
  })
  .passthrough();

export const AgentSelectOptionSchema = z
  .object({
    id: z.string(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    isDefault: z.boolean().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

export const AgentModelSchema = z
  .object({
    provider: z.string(),
    id: z.string(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    isDefault: z.boolean().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
    thinkingOptions: z.array(AgentSelectOptionSchema).nullish(),
    defaultThinkingOptionId: z.string().nullish(),
  })
  .passthrough();

// 30 seconds - surface friendly message before SDK tool timeout (~60s)
export const AGENT_WAIT_TIMEOUT_MS = 30000;

export interface ResolvedProviderModel {
  provider: AgentProvider;
  model: string | undefined;
}

export function resolveRequiredProviderModel(
  providerValue: string,
): Required<ResolvedProviderModel> {
  const providerInput = providerValue.trim();
  const slashIndex = providerInput.indexOf("/");
  if (slashIndex <= 0 || slashIndex === providerInput.length - 1) {
    throw new Error("provider must be provider/model, for example codex/gpt-5.4");
  }

  const provider = providerInput.slice(0, slashIndex).trim();
  const model = providerInput.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    throw new Error("provider must be provider/model, for example codex/gpt-5.4");
  }

  return {
    provider: provider,
    model,
  };
}

/**
 * Wraps agentManager.waitForAgentEvent with a self-imposed timeout.
 * Returns a friendly message when timeout occurs, rather than letting
 * the SDK tool timeout trigger a generic "tool failed" error.
 */
export async function waitForAgentWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  options?: {
    signal?: AbortSignal;
    waitForActive?: boolean;
  },
): Promise<WaitForAgentResult> {
  const timeoutController = new AbortController();
  const combinedController = new AbortController();

  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error("wait timeout"));
  }, AGENT_WAIT_TIMEOUT_MS);

  const forwardAbort = (reason: unknown) => {
    if (!combinedController.signal.aborted) {
      combinedController.abort(reason);
    }
  };

  if (options?.signal) {
    if (options.signal.aborted) {
      forwardAbort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", () => forwardAbort(options.signal!.reason), {
        once: true,
      });
    }
  }

  timeoutController.signal.addEventListener(
    "abort",
    () => forwardAbort(timeoutController.signal.reason),
    { once: true },
  );

  try {
    const result = await agentManager.waitForAgentEvent(agentId, {
      signal: combinedController.signal,
      waitForActive: options?.waitForActive,
    });
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "wait timeout") {
      const snapshot = agentManager.getAgent(agentId);
      const timeline = agentManager.getTimeline(agentId);
      const recent = selectItemsByProjectedLimit({
        items: timeline,
        direction: "tail",
        limit: 5,
      });
      const recentActivity = curateAgentActivity(recent.items);
      const waitedSeconds = Math.round(AGENT_WAIT_TIMEOUT_MS / 1000);
      const message = `Awaiting the agent timed out after ${waitedSeconds}s. This does not mean the agent failed - call wait_for_agent again to continue waiting.\n\nRecent activity:\n${recentActivity}`;
      return {
        status: snapshot?.lifecycle ?? "idle",
        permission: null,
        lastMessage: message,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function sanitizePermissionRequest(
  permission: AgentPermissionRequest | null | undefined,
): AgentPermissionRequest | null {
  if (!permission) {
    return null;
  }
  const sanitized: AgentPermissionRequest = { ...permission };
  if (sanitized.title === undefined) {
    delete sanitized.title;
  }
  if (sanitized.description === undefined) {
    delete sanitized.description;
  }
  if (sanitized.input === undefined) {
    delete sanitized.input;
  }
  if (sanitized.suggestions === undefined) {
    delete sanitized.suggestions;
  }
  if (sanitized.actions === undefined) {
    delete sanitized.actions;
  }
  if (sanitized.metadata === undefined) {
    delete sanitized.metadata;
  }
  return sanitized;
}

export async function resolveAgentTitle(
  agentStorage: AgentStorage,
  agentId: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const record = await agentStorage.get(agentId);
    return record?.title ?? null;
  } catch (error) {
    logger.error({ err: error, agentId }, "Failed to load agent title");
    return null;
  }
}

export async function serializeSnapshotWithMetadata(
  agentStorage: AgentStorage,
  snapshot: ManagedAgent,
  logger: Logger,
) {
  const title = await resolveAgentTitle(agentStorage, snapshot.id, logger);
  return serializeAgentSnapshot(snapshot, { title });
}

export function parseDurationString(input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  let totalMs = 0;
  let hasMatch = false;
  const regex = /(\d+)([smh])/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(trimmed)) !== null) {
    hasMatch = true;
    const value = Number.parseInt(match[1], 10);
    switch (match[2]) {
      case "s":
        totalMs += value * 1000;
        break;
      case "m":
        totalMs += value * 60 * 1000;
        break;
      case "h":
        totalMs += value * 60 * 60 * 1000;
        break;
    }
  }

  if (!hasMatch) {
    throw new Error(`Invalid duration format: ${input}. Use formats like: 5m, 30s, 1h, 2h30m`);
  }

  return totalMs;
}

export function toScheduleSummary(schedule: z.infer<typeof StoredScheduleSchema>) {
  const { runs: _runs, ...summary } = schedule;
  return summary;
}
