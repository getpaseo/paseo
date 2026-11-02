import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import {
  createLifecycleRegistration,
  pluginHookRegistry,
} from "@getpaseo/plugin/internal/lifecycle";
import { isDeepStrictEqual } from "node:util";
import {
  serializeAgentTool,
  agentToolMetadataSchema,
  type SessionOpenWireRequest,
  type PluginAgentTools,
} from "../agent-tools.js";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import type { AgentStreamEvent } from "../../agent/agent-sdk-types.js";
import { z } from "zod";
import { CreateAgentRequestMessageSchema } from "@getpaseo/protocol/messages";
import type {
  PluginHookAgent,
  PluginHookPayload,
  PluginHookContext,
  PluginLifecycleRegistration,
} from "@getpaseo/plugin/server";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  PluginHookRequests,
  PluginHookWorkspace,
  PluginHookEvents,
} from "@getpaseo/plugin/server";
import { WorkspaceCreateRequestSchema } from "@getpaseo/protocol/messages";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

export type PluginWireBeforeRequests = Omit<PluginHookRequests, "agent.open.before"> & {
  "agent.open.before": SessionOpenWireRequest;
};

/** Daemon-only results; ownership never crosses the plugin process boundary. */
export type PluginBeforeResults = PluginWireBeforeRequests & {
  "agent.open.before": SessionOpenWireRequest & { mcpServerOwners?: Record<string, string> };
};

const worktreeRequestFields = {
  repoRoot: z.string(),
  sourceCheckout: z.string(),
  branch: z.string().min(1),
  slug: z.string().refine((value) => validateBranchSlug(value).valid, "Invalid worktree slug"),
  path: z.string().min(1),
};
const changeRequestFields = {
  headRef: z.string().min(1),
  headRepositoryOwner: z.string().optional(),
  checkoutRefs: z
    .array(z.object({ remoteName: z.string().optional(), remoteRef: z.string() }))
    .optional(),
  pushRemoteUrl: z.string().optional(),
  trackOriginHead: z.boolean().optional(),
};
const worktreeRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...worktreeRequestFields, kind: z.literal("branch-off"), baseRef: z.string().min(1) })
    .strict(),
  z
    .object({
      ...worktreeRequestFields,
      kind: z.literal("checkout-branch"),
    })
    .strict(),
  z
    .object({
      ...worktreeRequestFields,
      ...changeRequestFields,
      kind: z.literal("checkout-change-request"),
      baseRef: z.string().min(1),
      forge: z.string(),
      changeRequestNumber: z.number().int().positive(),
      headRepository: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...worktreeRequestFields,
      ...changeRequestFields,
      kind: z.literal("checkout-github-pr"),
      baseRef: z.string().min(1),
      githubPrNumber: z.number().int().positive(),
    })
    .strict(),
]);

const beforeSchemas = {
  "worktree.create.before": worktreeRequestSchema,
  "agent.create.before": CreateAgentRequestMessageSchema.pick({
    config: true,
    env: true,
  }).strict(),
  "agent.open.before": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      provider: z.string(),
      cwd: z.string(),
      reason: z.enum(["create", "resume", "refresh", "import"]),
      purpose: z.enum(["interactive", "history"]),
      title: z.string().nullable(),
      labels: z.record(z.string(), z.string()),
      tools: z.array(agentToolMetadataSchema),
      env: z.record(z.string(), z.string()),
      mcpServers: CreateAgentRequestMessageSchema.shape.config.shape.mcpServers.unwrap(),
    })
    .strict(),
  "workspace.create.before": WorkspaceCreateRequestSchema.omit({
    type: true,
    requestId: true,
  }).strict(),
};

const sessionOpenLocalResultSchema = beforeSchemas["agent.open.before"].extend({
  tools: z.array(
    z.custom<AgentToolDefinition>(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        "input" in tool &&
        "execute" in tool &&
        typeof tool.execute === "function",
    ),
  ),
});

export interface PluginLifecycle {
  wait(
    name: "worktree.create.after",
    payload: PluginHookPayload<"worktree.create.after">,
  ): Promise<void>;
  emit<Name extends keyof PluginHookEvents>(name: Name, event: PluginHookEvents[Name]): void;
  before<Name extends keyof PluginWireBeforeRequests>(
    name: Name,
    request: PluginWireBeforeRequests[Name],
  ): Promise<PluginBeforeResults[Name]>;
}

export function validateBeforeRequest<Name extends keyof PluginWireBeforeRequests>(
  name: Name,
  value: unknown,
): PluginWireBeforeRequests[Name] {
  return beforeSchemas[name].parse(value) as PluginWireBeforeRequests[Name];
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
): void {
  if (event.type === "turn_started") {
    lifecycle.emit("agent.turn.before", { agent, turnId: event.turnId ?? null });
  } else if (event.type === "turn_completed") {
    lifecycle.emit("agent.turn.after", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "completed" },
    });
  } else if (event.type === "turn_failed") {
    lifecycle.emit("agent.turn.after", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "failed", error: { message: event.error, code: event.code } },
    });
  } else if (event.type === "turn_canceled") {
    lifecycle.emit("agent.turn.after", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "canceled", reason: event.reason },
    });
  } else if (event.type === "permission_requested") {
    lifecycle.emit("agent.permission.before", { agent, request: event.request });
  } else if (event.type === "permission_resolved") {
    lifecycle.emit("agent.permission.after", {
      agent,
      requestId: event.requestId,
      resolution: event.resolution,
    });
  }
}

export async function validateBeforeResult<Name extends keyof PluginWireBeforeRequests>(
  name: Name,
  input: PluginWireBeforeRequests[Name],
  output: unknown,
): Promise<PluginWireBeforeRequests[Name]> {
  const result = validateBeforeRequest(name, output);
  if (name === "agent.open.before") {
    const previous = beforeSchemas["agent.open.before"].parse(input);
    const next = beforeSchemas["agent.open.before"].parse(result);
    if (
      previous.agentId !== next.agentId ||
      previous.workspaceId !== next.workspaceId ||
      previous.provider !== next.provider ||
      previous.cwd !== next.cwd ||
      previous.reason !== next.reason ||
      previous.purpose !== next.purpose ||
      previous.title !== next.title ||
      !isDeepStrictEqual(previous.labels, next.labels)
    ) {
      throw new Error("agent.open.before hooks can only change env, tools, and mcpServers");
    }
  }
  if (name === "agent.create.before") {
    const previous = beforeSchemas["agent.create.before"].parse(input);
    const next = beforeSchemas["agent.create.before"].parse(result);
    if (previous.config.cwd !== next.config.cwd) {
      throw new Error("agent.create.before hooks cannot change the workspace directory");
    }
  }
  if (name === "worktree.create.before") {
    const previous = beforeSchemas["worktree.create.before"].parse(input);
    const next = beforeSchemas["worktree.create.before"].parse(result);
    if (previous.repoRoot !== next.repoRoot || previous.sourceCheckout !== next.sourceCheckout) {
      throw new Error("worktree.create.before hooks cannot change repoRoot or sourceCheckout");
    }
  }
  return result;
}

type Handler = (input: unknown, context: PluginHookContext) => unknown;

export class PluginHookHandlers implements PluginLifecycleRegistration {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly active = new Map<string, AbortController>();

  private readonly changed: () => void;

  private readonly agentTools: PluginAgentTools | undefined;

  constructor(changed: () => void, agentTools?: PluginAgentTools) {
    this.agentTools = agentTools;
    this.changed = changed;
    const registration = createLifecycleRegistration((name, handler) =>
      this.register(name, handler as Handler),
    );
    this.addHook = registration.addHook;
    this.on = registration.on;
    this.before = registration.before;
  }

  readonly addHook: PluginLifecycleRegistration["addHook"];
  readonly on: PluginLifecycleRegistration["on"];
  readonly before: PluginLifecycleRegistration["before"];

  catalog(): string[] {
    return [...this.handlers.keys()];
  }

  async invoke(
    id: string,
    name: string,
    input: unknown,
    paseo: PluginHookContext["paseo"],
  ): Promise<unknown> {
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      if (Object.hasOwn(beforeSchemas, name)) {
        const hookName = name as keyof PluginHookRequests;
        if (hookName === "agent.open.before") {
          return await this.openSession(input, { paseo, signal: controller.signal });
        }
        let request = validateBeforeRequest(hookName, input);
        for (const handler of this.handlers.get(name) ?? []) {
          controller.signal.throwIfAborted();
          const result = await handler(
            { request: structuredClone(request) },
            { paseo, signal: controller.signal },
          );
          if (result !== undefined) request = await validateBeforeResult(hookName, request, result);
        }
        return request;
      }
      for (const handler of this.handlers.get(name) ?? []) {
        controller.signal.throwIfAborted();
        try {
          await handler(structuredClone(input), { paseo, signal: controller.signal });
        } catch (error) {
          if (
            Object.hasOwn(pluginHookRegistry, name) &&
            pluginHookRegistry[name as keyof typeof pluginHookRegistry].waits
          )
            throw error;
          console.error(`Lifecycle hook ${name} failed`, error);
        }
      }
      return null;
    } finally {
      this.active.delete(id);
    }
  }

  private async openSession(
    input: unknown,
    context: PluginHookContext,
  ): Promise<SessionOpenWireRequest> {
    let request = validateBeforeRequest("agent.open.before", input);
    this.agentTools?.detach(request.agentId);
    let tools: AgentToolDefinition[] = [];
    for (const handler of this.handlers.get("agent.open.before") ?? []) {
      context.signal.throwIfAborted();
      const result = await handler(
        { request: { ...structuredClone(request), tools: [...tools] } },
        context,
      );
      if (result === undefined) continue;
      const local = sessionOpenLocalResultSchema.parse(result);
      const metadata = local.tools.map(serializeAgentTool);
      request = await validateBeforeResult("agent.open.before", request, {
        ...local,
        tools: metadata,
      });
      tools = local.tools;
    }
    context.signal.throwIfAborted();
    if (request.purpose === "history") {
      request.tools = [];
      request.mcpServers = {};
    } else this.agentTools?.attach(request.agentId, tools);
    return request;
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  close(): void {
    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.handlers.clear();
  }

  private register(name: string, handler: Handler): () => void {
    let handlers = this.handlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(name, handlers);
    }
    handlers.add(handler);
    this.changed();
    return () => {
      if (!handlers.delete(handler)) {
        return;
      }
      if (handlers.size === 0) {
        this.handlers.delete(name);
      }
      this.changed();
    };
  }
}
