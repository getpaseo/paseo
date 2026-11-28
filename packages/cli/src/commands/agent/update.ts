import type { Command } from "commander";
import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
import {
  formatFeatureValues,
  parseFeatureFlags,
  resolveFeatureValues,
} from "../../utils/agent-features.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

/** Result type for agent update command */
export interface AgentUpdateResult {
  agentId: string;
  name: string | null;
  labels: string;
  thinkingOptionId: string | null;
  features: string;
  noticeType: AgentProviderNotice["type"] | null;
  notice: string | null;
}

/** Schema for update command output */
export const updateSchema: OutputSchema<AgentUpdateResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "NAME", field: "name" },
    { header: "LABELS", field: "labels" },
    { header: "THINKING", field: "thinkingOptionId" },
    { header: "FEATURES", field: "features" },
    { header: "NOTICE", field: "notice" },
  ],
};

export interface AgentUpdateOptions extends CommandOptions {
  name?: string;
  label?: string[];
  thinking?: string;
  feature?: string[];
  host?: string;
}

export type AgentUpdateCommandResult = SingleResult<AgentUpdateResult>;

export interface AgentMetadataChanges {
  name?: string;
  labels?: Record<string, string>;
}

interface AgentUpdateServerInfo {
  features?: { agentThinkingUpdate?: boolean };
}

export interface AgentUpdateClient {
  getLastServerInfoMessage(): AgentUpdateServerInfo | null;
  updateAgent(agentId: string, updates: AgentMetadataChanges): Promise<void>;
  setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string,
  ): Promise<AgentProviderNotice | null>;
}

export interface AgentFeatureUpdateClient {
  setAgentFeature(agentId: string, featureId: string, value: unknown): Promise<void>;
}

export type AgentChanges =
  | { type: "metadata"; updates: AgentMetadataChanges }
  | { type: "thinking"; thinkingOptionId: string };

// Feature values are checked against the agent's own features once it is fetched.
type ParsedAgentChanges = AgentChanges | { type: "features"; requested: Record<string, string> };

export interface AppliedAgentChanges {
  notice: AgentProviderNotice | null;
}

export function toAgentUpdateResult(
  agent: Pick<
    AgentSnapshotPayload,
    "id" | "title" | "labels" | "effectiveThinkingOptionId" | "features"
  >,
  appliedChanges: AppliedAgentChanges,
): AgentUpdateResult {
  return {
    agentId: agent.id,
    name: agent.title,
    labels: formatLabels(agent.labels),
    thinkingOptionId: agent.effectiveThinkingOptionId ?? null,
    features: formatFeatureValues(agent.features),
    noticeType: appliedChanges.notice?.type ?? null,
    notice: appliedChanges.notice?.message ?? null,
  };
}

export async function applyAgentChanges(
  client: AgentUpdateClient,
  agentId: string,
  changes: AgentChanges,
): Promise<AppliedAgentChanges> {
  if (changes.type === "thinking") {
    // COMPAT(agentThinkingUpdate): added in v0.2.4, remove gate after 2027-01-28.
    if (client.getLastServerInfoMessage()?.features?.agentThinkingUpdate !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to use agent thinking updates.",
      } satisfies CommandError;
    }
    const notice = await client.setAgentThinkingOption(agentId, changes.thinkingOptionId);
    return { notice };
  }
  await client.updateAgent(agentId, changes.updates);
  return { notice: null };
}

export interface AgentFeatureUpdate {
  agent: Pick<AgentSnapshotPayload, "id" | "features">;
  requested: Record<string, string>;
}

/**
 * Rejects malformed ids and values absent from the agent's features before setting any, then sets
 * them one by one. The setters are not a transaction: when one fails, the ones the daemon
 * confirmed stay applied, and the failed one may or may not have taken effect.
 */
export async function updateAgentFeatures(
  client: AgentFeatureUpdateClient,
  update: AgentFeatureUpdate,
): Promise<void> {
  const values = resolveFeatureValues(update.requested, update.agent.features ?? []);
  const confirmed: string[] = [];
  for (const [featureId, value] of Object.entries(values)) {
    try {
      await client.setAgentFeature(update.agent.id, featureId, value);
    } catch (error) {
      throw featureUpdateFailed({ featureId, confirmed, error });
    }
    confirmed.push(`${featureId}=${String(value)}`);
  }
}

interface FeatureUpdateFailure {
  featureId: string;
  confirmed: string[];
  error: unknown;
}

function featureUpdateFailed(failure: FeatureUpdateFailure): CommandError {
  const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
  let confirmed = "No feature update was confirmed.";
  if (failure.confirmed.length > 0) {
    confirmed = `Confirmed before the failure: ${failure.confirmed.join(", ")}.`;
  }
  return {
    code: "FEATURE_UPDATE_FAILED",
    message: `Failed to set feature ${failure.featureId}: ${reason}`,
    details: `${confirmed} The state of ${failure.featureId} is unconfirmed.`,
  };
}

function parseLabelOptions(labels: string[] | undefined): Record<string, string> {
  const parsed: Record<string, string> = {};
  if (!labels) {
    return parsed;
  }

  for (const rawLabel of labels) {
    for (const segment of rawLabel.split(",")) {
      const label = segment.trim();
      if (!label) {
        continue;
      }

      const eqIndex = label.indexOf("=");
      if (eqIndex === -1) {
        const error: CommandError = {
          code: "INVALID_LABEL",
          message: `Invalid label format: ${label}`,
          details: "Labels must be in key=value format",
        };
        throw error;
      }

      const key = label.slice(0, eqIndex).trim();
      const value = label.slice(eqIndex + 1);
      if (!key) {
        const error: CommandError = {
          code: "INVALID_LABEL",
          message: `Invalid label format: ${label}`,
          details: "Labels must include a non-empty key in key=value format",
        };
        throw error;
      }

      parsed[key] = value;
    }
  }

  return parsed;
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return "-";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

function parseAgentChanges(options: AgentUpdateOptions): ParsedAgentChanges {
  const name = options.name?.trim();
  if (options.name !== undefined && !name) {
    throw {
      code: "INVALID_NAME",
      message: "Name cannot be empty",
      details: "Use --name <name> with a non-empty value",
    } satisfies CommandError;
  }

  const labels = parseLabelOptions(options.label);
  const requestedFeatures = parseFeatureFlags(options.feature);
  const hasFeatureUpdates = Object.keys(requestedFeatures).length > 0;
  const thinkingOptionId = options.thinking?.trim();
  if (options.thinking !== undefined && !thinkingOptionId) {
    throw {
      code: "INVALID_THINKING_OPTION",
      message: "--thinking cannot be empty",
      details:
        'Provide a thinking option ID. Use "paseo provider models <provider> --thinking" to list valid IDs.',
    } satisfies CommandError;
  }

  const hasMetadataUpdates = Boolean(name) || Object.keys(labels).length > 0;
  if (hasMetadataUpdates && thinkingOptionId) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--thinking cannot be combined with --name or --label",
      details: "Run separate agent update commands for runtime settings and metadata.",
    } satisfies CommandError;
  }
  if (hasFeatureUpdates && (hasMetadataUpdates || thinkingOptionId)) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--feature cannot be combined with --name, --label or --thinking",
      details: "Run separate agent update commands for features, thinking and metadata.",
    } satisfies CommandError;
  }
  if (!hasMetadataUpdates && !thinkingOptionId && !hasFeatureUpdates) {
    throw {
      code: "NO_CHANGES_PROVIDED",
      message: "Nothing to update",
      details:
        "Provide at least one of: --name <name>, --label <key=value>, --thinking <id>, --feature <id=value>",
    } satisfies CommandError;
  }

  if (hasFeatureUpdates) {
    return { type: "features", requested: requestedFeatures };
  }
  if (thinkingOptionId) {
    return { type: "thinking", thinkingOptionId };
  }
  return {
    type: "metadata",
    updates: {
      ...(name ? { name } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
    },
  };
}

export async function runUpdateCommand(
  agentIdArg: string,
  options: AgentUpdateOptions,
  _command: Command,
): Promise<AgentUpdateCommandResult> {
  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent update <id> [--name <name>] [--label <key=value>]",
    };
    throw error;
  }

  const changes = parseAgentChanges(options);

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const fetchResult = await client.fetchAgent({ agentId: agentIdArg });
    if (!fetchResult) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }
    const agentId = fetchResult.agent.id;

    let appliedChanges: AppliedAgentChanges = { notice: null };
    if (changes.type === "features") {
      await updateAgentFeatures(client, {
        agent: fetchResult.agent,
        requested: changes.requested,
      });
    } else {
      appliedChanges = await applyAgentChanges(client, agentId, changes);
    }

    const updatedResult = await client.fetchAgent({ agentId });
    if (!updatedResult) {
      throw new Error(`Agent not found after update: ${agentId}`);
    }

    await client.close();

    return {
      type: "single",
      data: toAgentUpdateResult(updatedResult.agent, appliedChanges),
      schema: updateSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "UPDATE_FAILED",
      message: `Failed to update agent: ${message}`,
    };
    throw error;
  }
}
