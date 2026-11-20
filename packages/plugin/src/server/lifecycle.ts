import type { AgentToolDefinition } from "./agent-tools.js";
import { z } from "zod";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentSessionConfig,
  JsonValue,
  ProviderOptions,
  ToolPolicy,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";
import type { LegacyAgentConfigState } from "@getpaseo/protocol/plugin-agent-config";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
}

export interface PluginSessionOpenContext extends PluginHookContext {
  readonly launch: {
    readonly id: string;
    readonly signal: AbortSignal;
    onDispose(cleanup: (outcome: { installed: boolean }) => void | Promise<void>): void;
    onInstalled(callback: () => void | Promise<void>): void;
    /** Retains this plugin instance's live prior contribution, or throws when none is valid. */
    retainPrevious(): PluginPriorContribution;
  };
}

export interface PluginPriorContribution {
  readonly launchId: string;
  readonly mcpServers: Readonly<NonNullable<AgentSessionConfig["mcpServers"]>>;
  readonly env: Readonly<Record<string, string>>;
  readonly appendSystemPrompt?: readonly string[];
  readonly toolPolicy?: ToolPolicy;
  readonly providerOptions?: ProviderOptions;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
  /** Data plugins stored on the workspace. Paseo never reads a key. */
  metadata: Record<string, JsonValue>;
}

export interface PluginHookWorktree {
  path: string;
  branch: string;
  sourceCheckout: string;
}

/** Resolved creation options before Git fetches refs or chooses a unique branch name. */
export type PluginWorktreeCreateRequest = {
  readonly repoRoot: string;
  readonly sourceCheckout: string;
  branch: string;
  slug: string;
  path: string;
} & (
  | { kind: "branch-off"; baseRef: string }
  | { kind: "checkout-branch" }
  | {
      kind: "checkout-change-request";
      baseRef: string;
      forge: string;
      changeRequestNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      headRepository?: string;
      checkoutRefs?: { remoteName?: string; remoteRef: string }[];
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
  | {
      kind: "checkout-github-pr";
      baseRef: string;
      githubPrNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      checkoutRefs?: { remoteName?: string; remoteRef: string }[];
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
);

export interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
  /** A helper hidden from tabs, lists and attention. Fixed at creation. */
  readonly background: boolean;
  /** Data plugins stored on the agent. Paseo never reads a key. */
  metadata: Record<string, JsonValue>;
}

const featureSupportSchema = z.enum(["supported", "unsupported", "unknown"]);
const launchRestrictionSchema = z.enum(["mutable", "fixed", "none", "unknown"]);

export const PluginOpenSupportSchema = z
  .object({
    adapter: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("builtin"), id: z.string().min(1) })
        .strict()
        .readonly(),
      z
        .object({ kind: z.literal("acp") })
        .strict()
        .readonly(),
      z
        .object({ kind: z.literal("plugin"), id: z.string().min(1) })
        .strict()
        .readonly(),
    ]),
    instructions: featureSupportSchema,
    mcpHttp: featureSupportSchema,
    exactMcpPreapproval: featureSupportSchema,
    reasons: z
      .object({
        instructions: z.enum(["not-established", "adapter-unsupported"]).optional(),
        mcpHttp: z.enum(["not-established", "adapter-unsupported"]).optional(),
        exactMcpPreapproval: z.enum(["not-established", "adapter-unsupported"]).optional(),
      })
      .strict()
      .readonly()
      .optional(),
    attachedTools: z
      .object({
        delivery: z.enum(["native", "mcp", "none", "unknown"]),
        enabled: z.boolean(),
        disabledTools: z.array(z.string()).readonly(),
      })
      .strict()
      .readonly(),
    restrictions: z
      .object({
        mcpConfiguration: launchRestrictionSchema,
        processEnvironment: launchRestrictionSchema,
      })
      .strict()
      .readonly(),
    providerOptions: z.array(z.string()).readonly(),
  })
  .strict()
  .readonly();

export type PluginOpenSupport = z.infer<typeof PluginOpenSupportSchema>;

export interface PluginSessionOpenRequest {
  agentId: string;
  /** Host-owned identity for this opening; omitted by hosts predating launch lifetimes. */
  readonly launchId?: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  readonly title: string | null;
  /** A helper hidden from tabs, lists and attention. Fixed at creation. */
  readonly background: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly metadata: Readonly<Record<string, JsonValue>>;
  /** Host-resolved support for this opening; absent on hosts predating adaptive features. */
  readonly openSupport?: PluginOpenSupport;
  /** Projected required configuration before this plugin contributes; never mutate it. */
  readonly baseConfig?: Readonly<AgentSessionConfig>;
  /** Static matches only; presence is not proof that the saved field belongs to this plugin. */
  readonly legacyConfigState?: LegacyAgentConfigState;
  readonly previousContribution?: PluginPriorContribution;
  /** Instructions appended for this open; not saved on the agent. */
  appendSystemPrompt?: string[];
  tools: AgentToolDefinition[];
  env: Record<string, string>;
  mcpServers: NonNullable<AgentSessionConfig["mcpServers"]>;
  /** Optional exact approvals, limited to this plugin's contributed server bindings. */
  toolPolicy?: ToolPolicy;
  /** Launch-only options. Explicit caller/default options win per top-level key. */
  providerOptions?: ProviderOptions;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginHookEvents {
  "agent.turn.before": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn.after": {
    agent: PluginHookAgent;
    turnId: string | null;
    /**
     * The payload carries no history. Read the turn with
     * `paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 1, wholeTurns: true })`
     * and keep the entries whose `turnId` equals this `turnId`. The result is empty when a newer turn
     * started before the read, or when `turnId` is `null`.
     */
    outcome: PluginTurnOutcome;
  };
  "agent.permission.before": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission.after": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archive.after": { agent: PluginHookAgent; archivedAt: string };
  "agent.create.after": { agent: PluginHookAgent };
  "agent.close.after": { agent: PluginHookAgent };
  "workspace.create.after": { workspace: PluginHookWorkspace };
  "workspace.archive.after": { workspace: PluginHookWorkspace };
}

export interface PluginHookRequests {
  "worktree.create.before": PluginWorktreeCreateRequest;
  "agent.create.before": {
    config: AgentSessionConfig;
    env?: Record<string, string>;
    /** Stored on the new agent. Always present in the payload; return it changed to change it. */
    metadata?: Record<string, JsonValue>;
  };
  "agent.open.before": PluginSessionOpenRequest;
  "workspace.create.before": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

/** What a hook may return. An omitted `metadata` stays as it was. */
type PluginHookRequestResults = Omit<PluginHookRequests, "agent.open.before"> & {
  // Read-only fields added after the first SDK stay optional in a result; omitted means unchanged.
  "agent.open.before": Omit<PluginSessionOpenRequest, "metadata" | "background"> & {
    readonly background?: boolean;
    metadata?: Readonly<Record<string, JsonValue>>;
  };
};

export type PluginHooks = {
  [Name in keyof PluginHookRequests]: {
    request: PluginHookRequests[Name];
    result: PluginHookRequestResults[Name];
  };
} & { [Name in keyof PluginHookEvents]: { payload: PluginHookEvents[Name] } } & {
  "worktree.create.after": { payload: { worktree: PluginHookWorktree } };
};

export type PluginHookPayload<Name extends keyof PluginHooks> = {
  [Key in keyof PluginHooks]: PluginHooks[Key] extends { request: infer Request }
    ? { request: Request }
    : PluginHooks[Key] extends { payload: infer Payload }
      ? Payload
      : never;
}[Name];
export type PluginHookResult<Name extends keyof PluginHooks> = {
  [Key in keyof PluginHooks]: PluginHooks[Key] extends { result: infer Result }
    ? Result | void
    : void;
}[Name];

type HookHandlers = {
  [Name in keyof PluginHooks]: (
    payload: PluginHookPayload<Name>,
    context: Name extends "agent.open.before" ? PluginSessionOpenContext : PluginHookContext,
  ) => Promise<PluginHookResult<Name>>;
};

export interface PluginLifecycleRegistration {
  addHook<Name extends keyof PluginHooks>(name: Name, handler: HookHandlers[Name]): () => void;
  /** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  /** @deprecated Use addHook with the renamed hook. Removed after 2027-04-30. */
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeResults[Name] | void | Promise<PluginBeforeResults[Name] | void>,
  ): () => void;
}

/** @internal Lifecycle policy shared by the daemon and plugin process. */
export const pluginHookRegistry = {
  "workspace.create.before": { waits: true },
  "workspace.create.after": { waits: false },
  "workspace.archive.after": { waits: false },
  "worktree.create.before": { waits: true },
  "worktree.create.after": { waits: true },
  "agent.create.before": { waits: true },
  "agent.create.after": { waits: false },
  "agent.open.before": { waits: true },
  "agent.close.after": { waits: false },
  "agent.archive.after": { waits: false },
  "agent.turn.before": { waits: false },
  "agent.turn.after": { waits: false },
  "agent.permission.before": { waits: false },
  "agent.permission.after": { waits: false },
} as const satisfies Record<keyof PluginHooks, { waits: boolean }>;

// COMPAT(pluginHookNames): added in v0.14, remove after 2027-04-30
const legacyEvents = {
  "workspace.created": "workspace.create.after",
  "workspace.archived": "workspace.archive.after",
  "agent.created": "agent.create.after",
  "agent.closed": "agent.close.after",
  "agent.archived": "agent.archive.after",
  "agent.turn_started": "agent.turn.before",
  "agent.turn_ended": "agent.turn.after",
  "agent.permission_requested": "agent.permission.before",
  "agent.permission_resolved": "agent.permission.after",
} as const;
const legacyRequests = {
  "workspace.create": "workspace.create.before",
  "agent.create": "agent.create.before",
  "agent.session_open": "agent.open.before",
} as const;
export type PluginLifecycleEvents = {
  [Name in keyof typeof legacyEvents]: PluginHookEvents[(typeof legacyEvents)[Name]];
};
export type PluginBeforeRequests = {
  [Name in keyof typeof legacyRequests]: PluginHookRequests[(typeof legacyRequests)[Name]];
};
type PluginBeforeResults = {
  [Name in keyof typeof legacyRequests]: PluginHookRequestResults[(typeof legacyRequests)[Name]];
};

/** @internal SDK adapter for the daemon's hook registry. */
export function createLifecycleRegistration(
  register: (
    name: keyof PluginHooks,
    handler: (input: never, context: never) => unknown,
  ) => () => void,
): PluginLifecycleRegistration {
  const names = new Set<string>(Object.keys(pluginHookRegistry));
  return {
    addHook(name, handler) {
      if (!names.has(name)) throw new Error(`Unknown lifecycle hook: ${name}`);
      return register(name, handler);
    },
    on(name, handler) {
      if (!Object.hasOwn(legacyEvents, name)) throw new Error(`Unknown lifecycle event: ${name}`);
      return register(legacyEvents[name], handler);
    },
    before(name, handler) {
      if (!Object.hasOwn(legacyRequests, name)) throw new Error(`Unknown before hook: ${name}`);
      return register(legacyRequests[name], handler);
    },
  };
}
