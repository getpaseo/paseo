import type { AgentPermissionRequest } from "../../agent-sdk-types.js";
export type FinishNotificationReason =
  | "host unreachable"
  | "host removed"
  | "finished"
  | "errored"
  | "needs permission"
  | "is unavailable"
  | "was closed"
  | "was canceled";

export const finishNotificationEvents = {
  "host unreachable": "errored",
  "host removed": "errored",
  finished: "finished",
  errored: "errored",
  "needs permission": "permission-required",
  "was closed": "closed",
  "is unavailable": "closed",
  // Use the existing failure event so older clients still parse agent-message metadata.
  "was canceled": "errored",
} as const;

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  serverId?: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

export function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  if (params.reason === "host unreachable" || params.reason === "host removed") {
    const host =
      params.reason === "host removed"
        ? `Host ${params.serverId} was removed or is unavailable.`
        : `Could not observe child agent ${params.childAgentId} on host ${params.serverId} after three failed attempts.`;
    return `${host}\n\nStatus of child agent ${params.childAgentId} (${params.title}) is unknown.\n\nServer: ${params.serverId}\n\nThis finish subscription has ended. Reassess the delegated work; reconnecting will not resume notifications.`;
  }
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.serverId) sections.push(`Server: ${params.serverId}`);
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          ...(params.serverId ? { serverId: params.serverId } : {}),
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}
