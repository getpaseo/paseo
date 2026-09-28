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
  /** Timeline items the custom message carries directly, such as mid-run progress. */
  timeline?: AgentTimelineItem[];
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
  /**
   * Live refresh, called while a child this session reported is still running.
   *
   * For plugins whose child state lives in a file of their own rather than in a tool result. The
   * returned mapping goes through the same path as `mapToolCall`, so it can report status, hand over
   * a child session file, or both.
   */
  poll?(): PiExtensionToolMapping | undefined;
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
