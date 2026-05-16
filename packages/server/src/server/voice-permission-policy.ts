import type { AgentPermissionRequest } from "./agent/agent-sdk-types.js";
import { isSpeakToolName } from "@getpaseo/protocol/tool-name-normalization";

/** Voice assistant policy: only allow the speak tool. */
export function isVoicePermissionAllowed(request: AgentPermissionRequest): boolean {
  if (request.kind !== "tool") {
    return false;
  }

  const normalizedName = request.name.trim().toLowerCase();
  if (!normalizedName) {
    return false;
  }

  return isSpeakToolName(normalizedName);
}
