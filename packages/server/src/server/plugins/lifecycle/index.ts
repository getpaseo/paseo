import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import {
  createLifecycleRegistration,
  pluginHookRegistry,
} from "@getpaseo/plugin/internal/lifecycle";
import { isAbsolute } from "node:path";
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
import type { JsonValue } from "@getpaseo/protocol/agent-types";
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

/** Session opens run through the plugin runtime's session attachments, which record each plugin's contribution. */
export type PluginLifecycleBeforeName = Exclude<
  keyof PluginWireBeforeRequests,
  "agent.open.before"
>;

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
    .object({
      ...worktreeRequestFields,
      kind: z.literal("branch-off"),
      baseRef: z.string().min(1),
      startPoint: z.string().min(1).optional(),
    })
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

const launchWrapSchema = z
  .tuple([z.string().refine(isAbsolute, "wrap executable must be an absolute path")], z.string())
  .optional();

const beforeSchemas = {
  "worktree.create.before": worktreeRequestSchema,
  "agent.create.before": CreateAgentRequestMessageSchema.pick({
    config: true,
    env: true,
    metadata: true,
  })
    // A plugin built before the field may omit it from its result; it can't change it.
    .extend({ workspaceId: z.string().nullable().optional() })
    .strict(),
  "agent.open.before": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      provider: z.string(),
      cwd: z.string(),
      reason: z.enum(["create", "resume", "refresh", "import"]),
      purpose: z.enum(["interactive", "history"]),
      title: z.string().nullable(),
      // Optional so a plugin that returns its own object keeps working; omitted means unchanged.
      background: z.boolean().optional(),
      labels: z.record(z.string(), z.string()),
      // Optional so a plugin that returns its own object keeps working; omitted means unchanged.
      metadata: z.record(z.string(), z.custom<JsonValue>()).optional(),
      appendSystemPrompt: z.array(z.string()).optional(),
      tools: z.array(agentToolMetadataSchema),
      env: z.record(z.string(), z.string()),
      mcpServers: CreateAgentRequestMessageSchema.shape.config.shape.mcpServers.unwrap(),
      wrap: launchWrapSchema,
    })
    .strict(),
  "workspace.create.before": WorkspaceCreateRequestSchema.omit({
    type: true,
    requestId: true,
  }).strict(),
  "terminal.create.before": z
    .object({
      workspaceId: z.string(),
      cwd: z.string(),
      source: z.enum(["client", "agent", "script", "worktree"]),
      name: z.string().nullable(),
      command: z.string().nullable(),
      args: z.array(z.string()),
      input: z.string().nullable(),
      env: z.record(z.string(), z.string()),
      wrap: launchWrapSchema,
    })
    .strict(),
  "command.run.before": z
    .object({
      workspaceId: z.string().nullable(),
      cwd: z.string(),
      purpose: z.enum(["setup", "teardown"]),
      command: z.string(),
      env: z.record(z.string(), z.string()),
      wrap: launchWrapSchema,
    })
    .strict(),
};

// Request fields a hook reads but can't change, with the error a changed one gets.
const readOnlyRequestFields = {
  "terminal.create.before": {
    fields: ["workspaceId", "cwd", "source", "name", "command", "args", "input"],
    message: "terminal.create.before hooks can only change env and wrap",
  },
  "command.run.before": {
    fields: ["workspaceId", "cwd", "purpose", "command"],
    message: "command.run.before hooks can only change env and wrap",
  },
} as const;

function assertReadOnlyFields(name: string, input: unknown, result: unknown): void {
  if (!Object.hasOwn(readOnlyRequestFields, name)) return;
  const { fields, message } = readOnlyRequestFields[name as keyof typeof readOnlyRequestFields];
  const previous = input as Record<string, unknown>;
  const next = result as Record<string, unknown>;
  if (fields.some((field) => !isDeepStrictEqual(previous[field], next[field])))
    throw new Error(message);
}

type LaunchWrap = z.infer<typeof launchWrapSchema>;

/**
 * One wrap per operation: the first hook that selects a wrap owns it. A later hook may omit it or
 * repeat it; a different wrap fails, so two sandboxes never silently stack or replace each other.
 */
function keepSelectedWrap(name: string, previous: LaunchWrap, next: LaunchWrap): LaunchWrap {
  if (previous && next && !isDeepStrictEqual(previous, next)) {
    throw new Error(`${name} hooks cannot change a wrap an earlier hook selected`);
  }
  return previous ?? next;
}

function withWrap<Result extends object>(result: Result, wrap: LaunchWrap): Result {
  const { wrap: _replaced, ...rest } = result as Result & { wrap?: LaunchWrap };
  return (wrap ? { ...rest, wrap } : rest) as Result;
}

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
  before<Name extends PluginLifecycleBeforeName>(
    name: Name,
    request: PluginWireBeforeRequests[Name],
  ): Promise<PluginWireBeforeRequests[Name]>;
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
    metadata: workspace.metadata,
  };
}

export function describeHookAgent(agent: {
  id: string;
  workspaceId?: string;
  provider: string;
  cwd: string;
  title?: string | null;
  background?: boolean;
  labels: Record<string, string>;
  metadata: Record<string, JsonValue>;
}): PluginHookAgent {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    parentAgentId: agent.labels[PARENT_AGENT_ID_LABEL] ?? null,
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title ?? null,
    background: agent.background === true,
    metadata: agent.metadata,
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
      outcome: { kind: "completed" },
    });
  } else if (event.type === "turn_failed") {
    lifecycle.emit("agent.turn.after", {
      agent,
      turnId: event.turnId ?? null,
      outcome: { kind: "failed", error: { message: event.error, code: event.code } },
    });
  } else if (event.type === "turn_canceled") {
    lifecycle.emit("agent.turn.after", {
      agent,
      turnId: event.turnId ?? null,
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

type SessionOpenRequest = z.infer<(typeof beforeSchemas)["agent.open.before"]>;

// Omitted `background` and `metadata` mean unchanged, so a hook returning its own object keeps working.
function changesSessionOpenTarget(previous: SessionOpenRequest, next: SessionOpenRequest): boolean {
  return (
    previous.agentId !== next.agentId ||
    previous.workspaceId !== next.workspaceId ||
    previous.provider !== next.provider ||
    previous.cwd !== next.cwd ||
    previous.reason !== next.reason ||
    previous.purpose !== next.purpose ||
    previous.title !== next.title ||
    (next.background !== undefined && previous.background !== next.background) ||
    !isDeepStrictEqual(previous.labels, next.labels) ||
    (next.metadata !== undefined && !isDeepStrictEqual(previous.metadata, next.metadata))
  );
}

type WorktreeBeforeRequest = z.infer<(typeof beforeSchemas)["worktree.create.before"]>;

function validateWorktreeBeforeResult(
  previous: WorktreeBeforeRequest,
  next: WorktreeBeforeRequest,
): WorktreeBeforeRequest {
  if (previous.repoRoot !== next.repoRoot || previous.sourceCheckout !== next.sourceCheckout) {
    throw new Error("worktree.create.before hooks cannot change repoRoot or sourceCheckout");
  }
  if (previous.kind === "branch-off" && next.kind === "branch-off") {
    if (next.startPoint !== undefined && next.startPoint !== previous.startPoint) {
      throw new Error("worktree.create.before hooks cannot change startPoint");
    }
    if (next.startPoint === undefined && previous.startPoint !== undefined) {
      return { ...next, startPoint: previous.startPoint };
    }
  } else if (next.kind === "branch-off" && next.startPoint !== undefined) {
    throw new Error("worktree.create.before hooks cannot change startPoint");
  }
  return next;
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
    if (changesSessionOpenTarget(previous, next)) {
      throw new Error(
        "agent.open.before hooks can only change env, tools, mcpServers, appendSystemPrompt, and wrap",
      );
    }
    return {
      ...withWrap(result, keepSelectedWrap(name, previous.wrap, next.wrap)),
      background: previous.background,
      metadata: previous.metadata,
      ...(next.appendSystemPrompt === undefined && previous.appendSystemPrompt !== undefined
        ? { appendSystemPrompt: previous.appendSystemPrompt }
        : {}),
    };
  }
  if (name === "agent.create.before") {
    const previous = beforeSchemas["agent.create.before"].parse(input);
    const next = beforeSchemas["agent.create.before"].parse(result);
    if (previous.config.cwd !== next.config.cwd) {
      throw new Error("agent.create.before hooks cannot change the workspace directory");
    }
    if ((next.workspaceId ?? previous.workspaceId ?? null) !== (previous.workspaceId ?? null)) {
      throw new Error("agent.create.before hooks cannot change the workspace");
    }
    // Omitted means unchanged: the next hook sees what this one was handed.
    return {
      ...result,
      metadata: next.metadata ?? previous.metadata,
      workspaceId: previous.workspaceId ?? null,
    };
  }
  if (name === "workspace.create.before") {
    const previous = beforeSchemas["workspace.create.before"].parse(input);
    const next = beforeSchemas["workspace.create.before"].parse(result);
    // Omitted means unchanged; an explicit {} still replaces.
    return { ...result, metadata: next.metadata ?? previous.metadata };
  }
  if (name === "terminal.create.before" || name === "command.run.before") {
    assertReadOnlyFields(name, input, result);
    const schema = beforeSchemas[name as "terminal.create.before" | "command.run.before"];
    const previous = schema.parse(input);
    const next = schema.parse(result);
    return withWrap(result, keepSelectedWrap(name, previous.wrap, next.wrap));
  }
  if (name === "worktree.create.before") {
    const previous = beforeSchemas["worktree.create.before"].parse(input);
    const next = beforeSchemas["worktree.create.before"].parse(result);
    return validateWorktreeBeforeResult(previous, next) as PluginWireBeforeRequests[Name];
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
    // Attaching replaces the session's definitions for later calls; calls already running finish. The daemon detaches
    // the session before an open that replaces the provider session.
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
      delete request.appendSystemPrompt;
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
