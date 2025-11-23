import type { AgentPermissionRequest } from "@server/server/agent/agent-sdk-types";

/**
 * Pending permission structure
 * Uses actual ACP types instead of any
 */
export interface PendingPermission {
  key: string;
  agentId: string;
  request: AgentPermissionRequest;
}

// Agent info interface is provided by SessionContext's Agent type
