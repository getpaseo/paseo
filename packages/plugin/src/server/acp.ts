import { createHash } from "node:crypto";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderCatalog,
  ProviderCatalogOptions,
  ProviderCatalogRefreshMode,
  ProviderCommand,
  ProviderConfigState,
  ProviderMode,
  ProviderNotice,
  ProviderPersistence,
  ProviderRegistration,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "./provider.js";
import { createAcpProviderConnection } from "./acp-internal/connection.js";

interface RunAcpProviderBaseOptions {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  catalogRefresh?: ProviderCatalogRefreshMode;
  acpOptions?: AcpOptions;
  transformers?: readonly AcpTransformer[];
}

export type RunAcpProviderOptions = RunAcpProviderBaseOptions &
  (
    | { command: readonly [string, ...string[]]; connector?: never }
    | { connector: AcpConnector; command?: never }
  );

export type AcpStreamMessage =
  | { jsonrpc: "2.0"; id: string | number | null; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

export interface AcpStream {
  writable: WritableStream<AcpStreamMessage>;
  readable: ReadableStream<AcpStreamMessage>;
}

export type AcpConnector = () => AcpStream | Promise<AcpStream>;

export interface AcpOptions {
  protocol?: "auto" | "v1";
  startupTimeoutMs?: number;
  /** Global discovery returns an empty catalog without spawning a process or opening a session. */
  workspaceOnlyCatalog?: boolean;
  /**
   * For an agent that lists thinking options only for the selected model: discovery selects each
   * model in turn and records the thinking options the agent lists for it, or none.
   */
  perModelThinkingOptions?: boolean;
  waitForInitialCommands?: boolean;
  initialCommandsTimeoutMs?: number;
  /**
   * For an agent that streams history after its session/load response: publish the session
   * as ready once this long passes without a history update.
   */
  loadReplayQuietPeriodMs?: number;
  /**
   * Keep a turn open after `end_turn` while qualifying tool calls are still running,
   * settling once those tools finish and the agent finishes its follow-up reply.
   */
  deferTurnOnRunningTools?: {
    /** Delay after `usage_update` closes a follow-up reply before settling. Defaults to 500ms. */
    settleDelayMs?: number;
    /** Quiet limit after qualifying tools finish if no reply settles via `usage_update`. Defaults to 120_000ms. */
    quietLimitMs?: number;
    /** Predicate deciding whether an open tool call keeps the turn open. Defaults to all running tools. */
    keepsTurnOpen?: (toolCall: AcpToolCallSnapshot) => boolean;
  };
  /** An unattended mode that approves ACP allow-once requests in the specified native mode. */
  autoAcceptMode?: {
    mode: Omit<ProviderMode, "isUnattended">;
    nativeMode: string;
    default?: boolean;
  };
}

export interface AcpContext {
  sessionId: string;
}

export interface AcpConfigAccess {
  read(): Promise<Readonly<Record<string, JsonValue>>>;
  set(id: string, value: JsonValue): Promise<void>;
}

/** Sends an ACP extension request to the agent. Rejects with the agent's JSON-RPC error. */
export type AcpRequest = (method: string, params: JsonValue) => Promise<JsonValue>;

export interface AcpDiscoveryContext extends AcpContext {
  config: AcpConfigAccess;
  request: AcpRequest;
}

export interface AcpConfigureContext extends AcpContext {
  config: AcpConfigAccess;
  request: AcpRequest;
  catalog(): ProviderCatalog;
  apply(change: AcpConfigChange): Promise<void>;
}

export type AcpConfigChange =
  | { target: "model"; value: string | null }
  | { target: "mode"; value: string | null }
  | { target: "thinking"; value: string | null }
  | { target: "setting"; id: string; value: JsonValue };

export interface AcpToolCallSnapshot {
  id: string;
  name?: string;
  title: string;
  kind?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  /** The call's ACP `rawInput`. */
  input: JsonValue;
  /** The call's ACP `rawOutput`. */
  output: JsonValue;
  /** The call's ACP `content` blocks. An update that sends `content` replaces them. */
  content?: JsonValue;
  locations: readonly string[];
  /** The row Paseo shows. Without it, Paseo builds the standard row for the call's ACP `kind`. */
  detail?: ProviderToolCallDetail;
}

export type AcpVendorUpdate =
  | { type: "commands"; commands: readonly ProviderCommand[] }
  | { type: "config"; config: ProviderConfigState }
  | { type: "timeline"; item: ProviderTimelineItem }
  | { type: "notice"; notice: ProviderNotice };

export interface AcpTransformer {
  /** Decode an older saved session and supply extension metadata for session/new or session/load. */
  sessionOpen?(context: {
    persistence?: ProviderPersistence;
    systemPrompt?: string;
    agentMetadata: JsonValue;
  }): { sessionId?: string; metadata?: Readonly<Record<string, JsonValue>> };

  discover?(
    catalog: ProviderCatalog,
    context: AcpDiscoveryContext,
  ): Promise<ProviderCatalog> | ProviderCatalog;
  configure?(change: AcpConfigChange, context: AcpConfigureContext): Promise<"handled" | "pass">;
  /** Rewrites every session config snapshot before Paseo sees it. */
  config?(state: ProviderConfigState, context: AcpContext): ProviderConfigState;
  /** Rewrites each advertised ACP slash command before Paseo sees it. */
  command?(command: ProviderCommand, context: AcpContext): ProviderCommand;
  notification?(
    notification: { method: string; params: JsonValue },
    context: AcpContext,
  ): AcpVendorUpdate | readonly AcpVendorUpdate[] | null;
  /** Rewrites each update of a tool call, merged with the call's earlier updates. */
  toolCall?(
    toolCall: AcpToolCallSnapshot,
    context: AcpContext & {
      mcpServerNames?: readonly string[];
      /** The call as Paseo last presented it, after every transformer. Absent on its first update. */
      previous?: AcpToolCallSnapshot;
    },
  ): AcpToolCallSnapshot;
}

function buildDefaultAcpCatalogCacheKey(options: ProviderCatalogOptions): string {
  if (!options.launch) return "acp:connector";
  const env = Object.entries(options.launch.env).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify(["acp:global/1", options.launch.command, options.launch.args, env]))
    .digest("hex");
}

export function runAcpProvider(options: RunAcpProviderOptions): ProviderRegistration {
  const hasCommand = options.command !== undefined;
  const hasConnector = options.connector !== undefined;
  if (hasCommand === hasConnector) {
    throw new Error("ACP provider requires exactly one command or SDK connector");
  }
  if (options.command && (options.command.length === 0 || options.command[0].trim().length === 0)) {
    throw new Error("ACP provider command must contain an executable");
  }
  const workspaceOnlyCatalog = options.acpOptions?.workspaceOnlyCatalog === true;
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    icon: options.icon,
    command: options.command,
    catalogRefresh: options.catalogRefresh ?? "on_demand",
    ...(workspaceOnlyCatalog
      ? {}
      : {
          async getCatalogCacheKey(catalogOptions) {
            return buildDefaultAcpCatalogCacheKey(catalogOptions);
          },
        }),
    // Each command-based session spawns its own process, so it can run behind that session's wrap.
    ...(hasCommand ? { launchWrap: true } : {}),
    connect(request) {
      return createAcpProviderConnection(options, request);
    },
  };
}
