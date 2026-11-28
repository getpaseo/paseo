import type { AgentPermissionRequest } from "../../agent-sdk-types.js";
import type { PendingWork } from "../index.js";
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
  "was canceled": "errored",
} as const;

const PENDING_WORK_DESCRIPTIONS: Record<PendingWork, string> = {
  turn: "a turn in progress",
  "background work": "background work that will wake it",
  "queued messages": "queued messages",
  "delegated agents": "agents it is waiting on",
};

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  serverId?: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
  /** The turn ended with this work pending; the subscription stays. */
  pendingWork?: readonly PendingWork[];
  /** The follow limit ended the subscription while the child still had pending work. */
  followLimit?: true;
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
  if (params.pendingWork?.length)
    sections.push(
      `It still has ${params.pendingWork.map((work) => PENDING_WORK_DESCRIPTIONS[work]).join(", ")}. You will be notified again when it settles, errors, or needs permission.`,
    );
  if (params.followLimit)
    sections.push(
      "Paseo stopped following it while it still had pending work. Check the agent with `get_agent_status`.",
    );
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
