import type { AgentResourcePolicy, AgentResourceStatus } from "@getpaseo/protocol/agent-resources";
import {
  applyResourcePatch,
  formatResourcePolicy,
  formatResourceStatus,
  parseResourcePatch,
  type ResourceOptions,
  type ResourcePolicyPatch,
} from "../../utils/resource-options.js";
import type { Command } from "commander";
import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon } from "../../utils/client.js";
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
  /** The stored policy, with the state of each control when it was just changed. */
  resources: string;
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
    { header: "RESOURCES", field: "resources" },
    { header: "NOTICE", field: "notice" },
  ],
};

export interface AgentUpdateOptions extends CommandOptions, ResourceOptions {
  name?: string;
  label?: string[];
  thinking?: string;
  host?: string;
}

export type AgentUpdateCommandResult = SingleResult<AgentUpdateResult>;

export interface AgentMetadataChanges {
  name?: string;
  labels?: Record<string, string>;
}

interface AgentUpdateServerInfo {
  features?: { agentThinkingUpdate?: boolean; agentResources?: boolean };
}

export interface AgentUpdateClient {
  getLastServerInfoMessage(): AgentUpdateServerInfo | null;
  updateAgent(agentId: string, updates: AgentMetadataChanges): Promise<void>;
  setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string,
  ): Promise<AgentProviderNotice | null>;
  getAgentResources(options: {
    agentId: string;
  }): Promise<{ resources: AgentResourcePolicy | null }>;
  setAgentResources(
    agentId: string,
    resources: AgentResourcePolicy | null,
  ): Promise<{ resources: AgentResourcePolicy | null; status: AgentResourceStatus | null }>;
}

export type AgentChanges =
  | { type: "metadata"; updates: AgentMetadataChanges }
  | { type: "thinking"; thinkingOptionId: string }
  | { type: "resources"; patch: ResourcePolicyPatch };

export interface AppliedAgentChanges {
  notice: AgentProviderNotice | null;
  /** Set when resources changed: the new policy and what is now in force. */
  resources?: { policy: AgentResourcePolicy | null; status: AgentResourceStatus | null };
}

export function toAgentUpdateResult(
  agent: Pick<
    AgentSnapshotPayload,
    "id" | "title" | "labels" | "effectiveThinkingOptionId" | "resources"
  >,
  appliedChanges: AppliedAgentChanges,
): AgentUpdateResult {
  return {
    agentId: agent.id,
    name: agent.title,
    labels: formatLabels(agent.labels),
    thinkingOptionId: agent.effectiveThinkingOptionId ?? null,
    resources: appliedChanges.resources
      ? formatResourceStatus(appliedChanges.resources.policy, appliedChanges.resources.status)
      : formatResourcePolicy(agent.resources),
    noticeType: appliedChanges.notice?.type ?? null,
    notice: appliedChanges.notice?.message ?? null,
  };
}

export async function applyAgentChanges(
  client: AgentUpdateClient,
  agentId: string,
  changes: AgentChanges,
): Promise<AppliedAgentChanges> {
  if (changes.type === "resources") {
    // COMPAT(agentResources): added in v0.17.0, remove gate after 2027-05-16.
    if (client.getLastServerInfoMessage()?.features?.agentResources !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "This host does not support agent resource controls.",
      } satisfies CommandError;
    }
    const { resources: current } = await client.getAgentResources({ agentId });
    const applied = await client.setAgentResources(
      agentId,
      applyResourcePatch(current, changes.patch),
    );
    return { notice: null, resources: { policy: applied.resources, status: applied.status } };
  }
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

function parseAgentChanges(options: AgentUpdateOptions): AgentChanges {
  const name = options.name?.trim();
  if (options.name !== undefined && !name) {
    throw {
      code: "INVALID_NAME",
      message: "Name cannot be empty",
      details: "Use --name <name> with a non-empty value",
    } satisfies CommandError;
  }

  const labels = parseLabelOptions(options.label);
  const resourcePatch = parseResourcePatch(options);
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
  if (resourcePatch && (hasMetadataUpdates || thinkingOptionId)) {
    throw {
      code: "INVALID_OPTIONS",
      message: "Resource flags cannot be combined with --name, --label or --thinking",
      details: "Run separate agent update commands for resources and other settings.",
    } satisfies CommandError;
  }
  if (resourcePatch) {
    return { type: "resources", patch: resourcePatch };
  }
  if (hasMetadataUpdates && thinkingOptionId) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--thinking cannot be combined with --name or --label",
      details: "Run separate agent update commands for runtime settings and metadata.",
    } satisfies CommandError;
  }
  if (!hasMetadataUpdates && !thinkingOptionId) {
    throw {
      code: "NO_CHANGES_PROVIDED",
      message: "Nothing to update",
      details:
        "Provide at least one of: --name <name>, --label <key=value>, --thinking <id>, or a resource flag such as --nice <n>",
    } satisfies CommandError;
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

    const appliedChanges = await applyAgentChanges(client, agentId, changes);

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
