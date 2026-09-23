import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  ToolCallDetail,
  AgentTimelineItem,
} from "../../../agent-sdk-types.js";
import type { PiRuntimeEvent } from "../rpc-types.js";
import type { PiToolResult } from "../tool-call-mapper.js";

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
}

export type PiExtensionDialog = Extract<PiRuntimeEvent, { type: "extension_ui_request" }>;
export interface PiExtensionUiResponse {
  value?: string;
  cancelled?: boolean;
  confirmed?: boolean;
}
export type PiExtensionDialogMapping =
  | { type: "permission"; request: AgentPermissionRequest }
  | { type: "response"; response: PiExtensionUiResponse };

export interface PiExtensionSession {
  mapToolCall?(call: PiExtensionToolCall): PiExtensionToolMapping | undefined;
  onToolStart?(call: PiExtensionToolCall): void;
  onToolEnd?(call: PiExtensionToolCall): void;
  mapDialog?(dialog: PiExtensionDialog, provider: string): PiExtensionDialogMapping | undefined;
  respondToPermission?(
    request: AgentPermissionRequest,
    response: AgentPermissionResponse,
  ): PiExtensionUiResponse | undefined;
}

export interface PiExtension {
  id: string;
  createSession(): PiExtensionSession;
}
