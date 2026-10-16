import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { WSOutboundMessage } from "./messages.js";

// COMPAT(workspaceConflictModel): added in v0.11.1, remove after 2027-04-16 once the client floor supports conflictModel.
export function workspaceConflictModelMessage(
  message: WSOutboundMessage,
  supported: boolean,
): WSOutboundMessage {
  if (supported || message.type !== "session") return message;
  const msg = message.message;
  if (
    msg.type !== "get_daemon_config_response" &&
    msg.type !== "set_daemon_config_response" &&
    !(msg.type === "status" && msg.payload.status === "daemon_config_changed")
  )
    return message;
  const config = msg.payload.config as MutableDaemonConfig;
  if (!config?.workspaceGitWorkflow || !("conflictModel" in config.workspaceGitWorkflow))
    return message;
  const { conflictModel: _, ...workflow } = config.workspaceGitWorkflow;
  return {
    ...message,
    message: {
      ...msg,
      payload: { ...msg.payload, config: { ...config, workspaceGitWorkflow: workflow } },
    },
  } as WSOutboundMessage;
}
