import type { AgentStreamEvent, AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import { z } from "zod";
import { CreateAgentRequestMessageSchema } from "@getpaseo/protocol/messages";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  PluginBeforeRequests,
  PluginHookWorkspace,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";
import { WorkspaceCreateRequestSchema } from "@getpaseo/protocol/messages";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

export const lifecycleEventNames = [
  "agent.created",
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "workspace.created",
  "workspace.archived",
] as const;
export const beforeHookNames = ["agent.create", "agent.session_open", "workspace.create"] as const;

const beforeSchemas = {
  "agent.create": CreateAgentRequestMessageSchema.pick({ config: true, env: true }).strict(),
  "agent.session_open": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      provider: z.string(),
      cwd: z.string(),
      reason: z.enum(["create", "resume", "refresh", "import"]),
      purpose: z.enum(["interactive", "history"]),
      env: z.record(z.string(), z.string()),
    })
    .strict(),
  "workspace.create": WorkspaceCreateRequestSchema.omit({ type: true, requestId: true }).strict(),
};

export interface PluginLifecycle {
  emit<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    event: PluginLifecycleEvents[Name],
  ): void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    request: PluginBeforeRequests[Name],
  ): Promise<PluginBeforeRequests[Name]>;
}

export function validateBeforeRequest<Name extends keyof PluginBeforeRequests>(
  name: Name,
  value: unknown,
): PluginBeforeRequests[Name] {
  return beforeSchemas[name].parse(value) as PluginBeforeRequests[Name];
}

export function describeHookWorkspace(workspace: PersistedWorkspaceRecord): PluginHookWorkspace {
  return {
    id: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    name: workspace.title,
    archivedAt: workspace.archivedAt,
  };
}

export function describeHookAgent(agent: {
  id: string;
  workspaceId?: string;
  provider: string;
  cwd: string;
  title?: string | null;
  labels: Record<string, string>;
}): PluginHookAgent {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    parentAgentId: agent.labels[PARENT_AGENT_ID_LABEL] ?? null,
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title ?? null,
  };
}

export function publishAgentStream(
  lifecycle: PluginLifecycle,
  agent: PluginHookAgent,
  event: AgentStreamEvent,
  timeline: readonly AgentTimelineItem[],
): void {
  if (event.type === "turn_started") {
    lifecycle.emit("agent.turn_started", { agent, turnId: event.turnId ?? null });
  } else if (event.type === "turn_completed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline,
      outcome: { kind: "completed" },
    });
  } else if (event.type === "turn_failed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline,
      outcome: { kind: "failed", error: { message: event.error, code: event.code } },
    });
  } else if (event.type === "turn_canceled") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline,
      outcome: { kind: "canceled", reason: event.reason },
    });
  } else if (event.type === "permission_requested") {
    lifecycle.emit("agent.permission_requested", { agent, request: event.request });
  } else if (event.type === "permission_resolved") {
    lifecycle.emit("agent.permission_resolved", {
      agent,
      requestId: event.requestId,
      resolution: event.resolution,
    });
  }
}

export function validateBeforeResult<Name extends keyof PluginBeforeRequests>(
  name: Name,
  input: PluginBeforeRequests[Name],
  output: unknown,
): PluginBeforeRequests[Name] {
  const result = validateBeforeRequest(name, output);
  if (name === "agent.session_open") {
    const previous = beforeSchemas["agent.session_open"].parse(input);
    const next = beforeSchemas["agent.session_open"].parse(result);
    if (
      previous.agentId !== next.agentId ||
      previous.workspaceId !== next.workspaceId ||
      previous.provider !== next.provider ||
      previous.cwd !== next.cwd ||
      previous.reason !== next.reason ||
      previous.purpose !== next.purpose
    ) {
      throw new Error("agent.session_open hooks can only change env");
    }
  }
  if (name === "agent.create") {
    const previous = beforeSchemas["agent.create"].parse(input);
    const next = beforeSchemas["agent.create"].parse(result);
    if (previous.config.cwd !== next.config.cwd) {
      throw new Error("agent.create hooks cannot change the workspace directory");
    }
  }
  return result;
}

export { PluginHookHandlers } from "./internal/handlers.js";
