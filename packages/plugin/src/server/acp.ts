import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  ProviderCatalog,
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
  /** Global discovery initializes ACP but returns an empty catalog without opening a session. */
  workspaceOnlyCatalog?: boolean;
  waitForInitialCommands?: boolean;
  initialCommandsTimeoutMs?: number;
  /** Allow delayed session/load updates before publishing the session as ready. */
  loadReplayQuietPeriodMs?: number;
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
  input: JsonValue;
  output: JsonValue;
  locations: readonly string[];
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
  notification?(
    notification: { method: string; params: JsonValue },
    context: AcpContext,
  ): AcpVendorUpdate | readonly AcpVendorUpdate[] | null;
  toolCall?(toolCall: AcpToolCallSnapshot, context: AcpContext): AcpToolCallSnapshot;
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
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    icon: options.icon,
    command: options.command,
    connect(request) {
      return createAcpProviderConnection(options, request);
    },
  };
}
