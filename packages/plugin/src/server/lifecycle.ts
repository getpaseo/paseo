import type { AgentToolDefinition } from "./agent-tools.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentSessionConfig,
  JsonValue,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
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
  | {
      kind: "branch-off";
      baseRef: string;
      /** Where the new branch starts when that is not `baseRef`, such as a fork's head. */
      readonly startPoint?: string;
    }
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

/**
 * A launcher Paseo starts a process behind: the process runs as `[...wrap, command, ...args]`.
 * The executable is an absolute path on the daemon host. Each element is one argument; no shell
 * parses them, except that Windows runs a `.cmd` or `.bat` executable through cmd.exe. A later
 * hook may omit the wrap or return the same one; a different wrap fails the operation.
 */
export type PluginLaunchWrap = readonly [executable: string, ...args: string[]];

/** A terminal Paseo is about to create in a workspace. */
export interface PluginTerminalCreateRequest {
  readonly workspaceId: string;
  readonly cwd: string;
  /**
   * `agent`: an agent's Paseo tool. `script`: a `paseo.json` script or service. `worktree`: a
   * `paseo.json` worktree terminal. `client`: everything else (the app, CLI, SDK, plugins).
   */
  readonly source: "client" | "agent" | "script" | "worktree";
  readonly name: string | null;
  /** The program the terminal starts, or `null` for the user's default shell. */
  readonly command: string | null;
  readonly args: readonly string[];
  /** What Paseo types into the shell once it starts: the command of a script or worktree terminal. */
  readonly input: string | null;
  /** Environment overrides for the terminal; excludes the daemon's inherited environment. */
  env: Record<string, string>;
  /** Start the terminal as `[...wrap, command, ...args]`; with no `command`, the default shell. */
  wrap?: PluginLaunchWrap;
}

/** A `paseo.json` worktree setup or teardown command Paseo is about to run. */
export interface PluginCommandRunRequest {
  /** Null when a worktree is archived by path and no workspace record remains. */
  readonly workspaceId: string | null;
  readonly cwd: string;
  readonly purpose: "setup" | "teardown";
  /** The command as written in `paseo.json`. Paseo runs it through a shell. */
  readonly command: string;
  /** Environment overrides for the command; excludes the daemon's inherited environment. */
  env: Record<string, string>;
  /** Start the command's shell as `[...wrap, shell, ...shellArgs]`. */
  wrap?: PluginLaunchWrap;
}

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

export interface PluginSessionOpenRequest {
  agentId: string;
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
  /** Instructions appended for this open; not saved on the agent. */
  appendSystemPrompt?: string[];
  tools: AgentToolDefinition[];
  env: Record<string, string>;
  mcpServers: NonNullable<AgentSessionConfig["mcpServers"]>;
  /**
   * Start the provider's harness as `[...wrap, command, ...args]`. Only a provider whose snapshot
   * entry has `launchWrap: true` applies it; any other provider fails the open. Not saved on the
   * agent.
   */
  wrap?: PluginLaunchWrap;
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
    /** The workspace the agent is created in, which `config.cwd` alone does not identify. */
    readonly workspaceId: string | null;
  };
  "agent.open.before": PluginSessionOpenRequest;
  "workspace.create.before": Omit<WorkspaceCreateRequest, "type" | "requestId">;
  "terminal.create.before": PluginTerminalCreateRequest;
  "command.run.before": PluginCommandRunRequest;
}

/** What a hook may return. An omitted `metadata` or `workspaceId` stays as it was. */
type PluginHookRequestResults = Omit<
  PluginHookRequests,
  "agent.open.before" | "agent.create.before"
> & {
  // Read-only fields added after the first SDK stay optional in a result; omitted means unchanged.
  "agent.open.before": Omit<PluginSessionOpenRequest, "metadata" | "background"> & {
    readonly background?: boolean;
    metadata?: Readonly<Record<string, JsonValue>>;
  };
  "agent.create.before": Omit<PluginHookRequests["agent.create.before"], "workspaceId"> & {
    readonly workspaceId?: string | null;
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
    context: PluginHookContext,
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
  "terminal.create.before": { waits: true },
  "command.run.before": { waits: true },
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
    handler: (input: never, context: PluginHookContext) => unknown,
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
