import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
  /** Daemon-attested obligations for this invocation; absent on ordinary agents. */
  readonly managedMcp?: PluginManagedMcpContext;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

export interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

export interface PluginManagedMcpContext {
  readonly opening: { readonly id: string; readonly digest: string };
  readonly servers: readonly {
    readonly name: string;
    readonly url: string;
    readonly ownerPluginId: string;
    readonly bindPluginId: string;
  }[];
}

export interface PluginMcpBinding {
  readonly openingId: string;
  readonly sessionEpoch: number;
  readonly bindRequestId: string;
}

export interface PluginManagedMcpDeclaration {
  bindPluginId: string;
  bootstrapEnvKeys?: string[];
  /** Assigned and checked by the daemon, not evidence supplied by the caller. */
  ownerPluginId?: string;
}

export interface PluginSessionOpenRequest {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  env: Record<string, string>;
}

export type PluginMcpBindRequest = Readonly<Omit<PluginSessionOpenRequest, "env">> & {
  readonly env: Readonly<Record<string, string>>;
  readonly opening: { readonly id: string; readonly digest: string };
  readonly bootstrapEnvKeys: readonly string[];
  readonly binding?: PluginMcpBinding;
};

export interface PluginMcpAuthorizationRequest {
  readonly session: Omit<PluginMcpBindRequest, "env" | "bootstrapEnvKeys" | "binding">;
  readonly binding: PluginMcpBinding;
  readonly server: { readonly name: string; readonly url: string };
  authorization?: string;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginLifecycleEvents {
  "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn_ended": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    /**
     * @deprecated Always empty. Fetch history on demand with
     * context.paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 }).
     */
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission_requested": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission_resolved": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archived": { agent: PluginHookAgent; archivedAt: string };
  "agent.created": { agent: PluginHookAgent };
  "agent.closed": { agent: PluginHookAgent };
  "workspace.created": { workspace: PluginHookWorkspace };
  "workspace.archived": { workspace: PluginHookWorkspace };
}

export interface PluginBeforeRequests {
  "agent.create": {
    config: AgentSessionConfig;
    env?: Record<string, string>;
    managedMcpServers?: Record<string, PluginManagedMcpDeclaration>;
  };
  "agent.session_open": PluginSessionOpenRequest;
  "agent.mcp_stage": PluginBeforeRequests["agent.create"];
  "agent.mcp_bind": PluginMcpBindRequest;
  "agent.mcp_authorization": PluginMcpAuthorizationRequest;
  "workspace.create": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export interface PluginLifecycleRegistration {
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>,
  ): () => void;
}
