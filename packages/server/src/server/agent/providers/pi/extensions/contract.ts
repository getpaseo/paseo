import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  ToolCallDetail,
  AgentTimelineItem,
} from "../../../agent-sdk-types.js";
import type { PiRuntimeEvent } from "../rpc-types.js";
import type { PiToolResult } from "../tool-call-mapper.js";
import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import type { PiAgentMessage } from "../rpc-types.js";

export interface PiExtensionToolCall {
  callId: string;
  toolName: string;
  args: unknown;
  status: "running" | "completed" | "failed";
  result: PiToolResult;
}

export interface PiExtensionToolMapping {
  name?: string;
  detail?: ToolCallDetail;
  timeline?: AgentTimelineItem[];
  subagents?: ProviderSubagentInputEvent[];
  childSessions?: PiChildSessionFile[];
}

export interface PiExtensionCustomMapping {
  subagents: ProviderSubagentInputEvent[];
  childSessions?: PiChildSessionFile[];
}

/**
 * A Pi child's append-only session file, mapped through the normal Pi history mapper. Report it as
 * soon as it is known; a live session follows it until the child's upsert reaches a final status.
 */
export interface PiChildSessionFile {
  id: string;
  file: string;
}

export type PiExtensionDialog = Extract<PiRuntimeEvent, { type: "extension_ui_request" }>;
export interface PiExtensionUiResponse {
  value?: string;
  cancelled?: boolean;
  confirmed?: boolean;
}
export type PiExtensionDialogMapping =
  | { type: "permission"; request: AgentPermissionRequest }
  | { type: "response"; response: PiExtensionUiResponse }
  | { type: "deferred" };

export interface PiExtensionUiReply {
  responses: Array<{ id: string; response: PiExtensionUiResponse }>;
}

export interface PiExtensionSession {
  mapToolCall?(call: PiExtensionToolCall): PiExtensionToolMapping | undefined;
  /** Claims a `ctx.ui.notify` message sent by this extension's `runtimeBridge`. */
  mapRuntimeNotification?(message: string): PiExtensionCustomMapping | undefined;
  /** Called on the live follow cadence to report state Pi only writes to disk. */
  poll?(): PiExtensionCustomMapping | undefined;
  mapCustomMessage?(
    message: Extract<PiAgentMessage, { role: "custom" }>,
  ): PiExtensionCustomMapping | undefined;
  onToolStart?(call: PiExtensionToolCall, provider: string): AgentPermissionRequest | undefined;
  onToolEnd?(call: PiExtensionToolCall): void;
  mapDialog?(dialog: PiExtensionDialog, provider: string): PiExtensionDialogMapping | undefined;
  respondToPermission?(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
  ): PiExtensionUiReply | undefined;
}

export interface PiExtension {
  id: string;
  /**
   * JavaScript statements run inside Paseo's Pi integration extension, with `pi` in scope. Reports
   * state that Pi's RPC stream omits through `ctx.ui.notify`, which reaches `mapRuntimeNotification`.
   */
  runtimeBridge?: string;
  createSession(): PiExtensionSession;
}
