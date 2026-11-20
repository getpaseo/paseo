import { validateBranchSlug } from "@getpaseo/protocol/branch-slug";
import {
  createLifecycleRegistration,
  pluginHookRegistry,
  PluginOpenSupportSchema,
} from "@getpaseo/plugin/internal/lifecycle";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
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
  PluginSessionOpenContext,
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
    metadata: true,
  }).strict(),
  "agent.open.before": z
    .object({
      agentId: z.string(),
      launchId: z.string().min(1).optional(),
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
      openSupport: PluginOpenSupportSchema.optional(),
      baseConfig: CreateAgentRequestMessageSchema.shape.config.optional(),
      legacyConfigState: z
        .object({ selectors: z.record(z.string(), z.enum(["present", "absent", "ambiguous"])) })
        .strict()
        .optional(),
      previousContribution: z
        .object({
          launchId: z.string().min(1),
          mcpServers: CreateAgentRequestMessageSchema.shape.config.shape.mcpServers.unwrap(),
          env: z.record(z.string(), z.string()),
          appendSystemPrompt: z.array(z.string()).optional(),
          toolPolicy: CreateAgentRequestMessageSchema.shape.config.shape.toolPolicy,
          providerOptions: CreateAgentRequestMessageSchema.shape.config.shape.providerOptions,
        })
        .strict()
        .optional(),
      retainedLaunchId: z.string().min(1).optional(),
      appendSystemPrompt: z.array(z.string()).optional(),
      toolPolicy: CreateAgentRequestMessageSchema.shape.config.shape.toolPolicy,
      providerOptions: CreateAgentRequestMessageSchema.shape.config.shape.providerOptions,
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

function freezeHookConfig<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeHookConfig(nested);
    Object.freeze(value);
  }
  return value;
}

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
    (next.launchId !== undefined && previous.launchId !== next.launchId) ||
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

export async function validateBeforeResult<Name extends keyof PluginWireBeforeRequests>(
  name: Name,
  input: PluginWireBeforeRequests[Name],
  output: unknown,
): Promise<PluginWireBeforeRequests[Name]> {
  const result = validateBeforeRequest(name, output);
  if (name === "agent.open.before") {
    const previous = beforeSchemas["agent.open.before"].parse(input);
    const next = beforeSchemas["agent.open.before"].parse(result);
    assertHostOwnedOpenFields(previous, next);
    if (changesSessionOpenTarget(previous, next)) {
      throw new Error(
        "agent.open.before hooks can only change env, tools, mcpServers, and appendSystemPrompt",
      );
    }
    return {
      ...result,
      background: previous.background,
      launchId: previous.launchId,
      metadata: previous.metadata,
      openSupport: previous.openSupport,
      baseConfig: previous.baseConfig,
      legacyConfigState: previous.legacyConfigState,
      previousContribution: previous.previousContribution,
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
    // Omitted means unchanged: the next hook sees what this one was handed.
    return { ...result, metadata: next.metadata ?? previous.metadata };
  }
  if (name === "workspace.create.before") {
    const previous = beforeSchemas["workspace.create.before"].parse(input);
    const next = beforeSchemas["workspace.create.before"].parse(result);
    // Omitted means unchanged; an explicit {} still replaces.
    return { ...result, metadata: next.metadata ?? previous.metadata };
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

function assertHostOwnedOpenFields(previous: SessionOpenRequest, next: SessionOpenRequest): void {
  for (const key of [
    "openSupport",
    "baseConfig",
    "legacyConfigState",
    "previousContribution",
  ] as const) {
    if (next[key] !== undefined && !isDeepStrictEqual(previous[key], next[key])) {
      throw new Error(`agent.open.before hooks cannot change host-owned ${key}`);
    }
  }
}

interface HookLaunchLifetime {
  agentId: string;
  controller: AbortController;
  cleanups: Array<(outcome: { installed: boolean }) => void | Promise<void>>;
  installed: boolean;
  installCallbacks: Array<() => void | Promise<void>>;
  retainedLaunchId?: string;
  users: number;
  releaseRequested: boolean;
  disposal?: Promise<void>;
}

export class PluginHookHandlers implements PluginLifecycleRegistration {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly active = new Map<string, AbortController>();
  private readonly launches = new Map<string, HookLaunchLifetime>();

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
    const request = validateBeforeRequest("agent.open.before", input);
    const id = request.launchId ?? randomUUID();
    this.openLaunch(request.agentId, id);
    try {
      return await this.runOpenHooks(request, context, id);
    } catch (error) {
      await this.disposeLaunch(id);
      throw error;
    }
  }

  private async runOpenHooks(
    input: unknown,
    context: PluginHookContext,
    id: string,
  ): Promise<SessionOpenWireRequest> {
    let request = validateBeforeRequest("agent.open.before", input);
    const lifetime = this.launches.get(id)!;
    const launch = {
      ...this.openLaunch(request.agentId, id),
      retainPrevious: () => {
        const previous = request.previousContribution;
        const prior = previous && this.launches.get(previous.launchId);
        if (
          !previous ||
          !prior ||
          prior.agentId !== request.agentId ||
          prior.controller.signal.aborted ||
          !prior.installed
        )
          throw new Error(
            "No live owner-specific prior contribution; fully close the agent and retained children, then reopen",
          );
        if (!lifetime.retainedLaunchId) {
          lifetime.retainedLaunchId = previous.launchId;
          prior.users += 1;
        }
        return freezeHookConfig(previous);
      },
    };
    const openContext: PluginSessionOpenContext = { ...context, launch };
    if (!request.launchId) this.agentTools?.detach(request.agentId);
    let tools: AgentToolDefinition[] = [];
    for (const handler of this.handlers.get("agent.open.before") ?? []) {
      context.signal.throwIfAborted();
      const result = await handler(
        {
          request: {
            ...structuredClone(request),
            openSupport: request.openSupport,
            baseConfig: freezeHookConfig(request.baseConfig),
            legacyConfigState: freezeHookConfig(request.legacyConfigState),
            previousContribution: freezeHookConfig(request.previousContribution),
            tools: [...tools],
          },
        },
        openContext,
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
    } else this.agentTools?.attach(request.agentId, tools, request.launchId);
    return { ...request, retainedLaunchId: lifetime.retainedLaunchId };
  }

  private openLaunch(agentId: string, id: string): PluginSessionOpenContext["launch"] {
    let lifetime = this.launches.get(id);
    if (!lifetime) {
      lifetime = {
        agentId,
        controller: new AbortController(),
        cleanups: [],
        installed: false,
        installCallbacks: [],
        users: 0,
        releaseRequested: false,
      };
      this.launches.set(id, lifetime);
    }
    if (lifetime.agentId !== agentId || lifetime.controller.signal.aborted) {
      throw new Error("Launch is disposed or belongs to another agent");
    }
    const owner = lifetime;
    return {
      id,
      signal: owner.controller.signal,
      onDispose(cleanup) {
        if (owner.controller.signal.aborted) throw new Error("Launch is already disposed");
        owner.cleanups.push(cleanup);
      },
      onInstalled(callback) {
        if (owner.installed || owner.controller.signal.aborted)
          throw new Error("Launch installation callback registered too late");
        owner.installCallbacks.push(callback);
      },
      retainPrevious() {
        throw new Error("No prior contribution was supplied for this opening");
      },
    };
  }

  disposeLaunch(id: string): Promise<void> {
    const lifetime = this.launches.get(id);
    if (!lifetime) return Promise.resolve();
    lifetime.releaseRequested = true;
    if (lifetime.users > 0) return Promise.resolve();
    if (lifetime.disposal) return lifetime.disposal;
    lifetime.controller.abort();
    this.agentTools?.detach(lifetime.agentId, id);
    lifetime.disposal = (async () => {
      const results = await Promise.allSettled(
        lifetime.cleanups
          .splice(0)
          .map(async (cleanup) => cleanup({ installed: lifetime.installed })),
      );
      if (lifetime.retainedLaunchId) await this.releaseRetainedLaunch(lifetime.retainedLaunchId);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Plugin launch cleanup failed");
    })();
    void lifetime.disposal.then(
      () => {
        if (this.launches.get(id) === lifetime) this.launches.delete(id);
        return undefined;
      },
      () => {},
    );
    return lifetime.disposal;
  }

  async installLaunch(id: string): Promise<void> {
    const lifetime = this.launches.get(id);
    if (!lifetime || lifetime.controller.signal.aborted)
      throw new Error("Cannot install a disposed plugin launch");
    if (lifetime.installed) return;
    lifetime.installed = true;
    for (const callback of lifetime.installCallbacks.splice(0)) await callback();
  }

  private async releaseRetainedLaunch(id: string): Promise<void> {
    const prior = this.launches.get(id);
    if (!prior) throw new Error("Retained plugin launch disappeared before release");
    prior.users -= 1;
    if (prior.releaseRequested && prior.users === 0) await this.disposeLaunch(id);
  }

  async disposeLaunches(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.launches.keys()].map((id) => this.disposeLaunch(id)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Plugin launch cleanup failed");
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
