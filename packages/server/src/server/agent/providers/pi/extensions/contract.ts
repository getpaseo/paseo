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
  /** Completed Pi child sessions to hydrate through the normal Pi history mapper. */
  childSessions?: Array<{ id: string; file: string }>;
}

export interface PiExtensionCustomMapping {
  subagents: ProviderSubagentInputEvent[];
  childSessions?: Array<{ id: string; file: string }>;
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
  createSession(): PiExtensionSession;
}
