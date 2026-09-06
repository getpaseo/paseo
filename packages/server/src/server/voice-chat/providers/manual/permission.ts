import { isSpeakToolName } from "@getpaseo/protocol/tool-name-normalization";
import type { AgentPermissionRequest } from "../../../agent/agent-sdk-types.js";

export function isManualVoicePermissionAllowed(request: AgentPermissionRequest): boolean {
  if (request.kind !== "tool") return false;
  const normalizedName = request.name.trim().toLowerCase();
  return normalizedName.length > 0 && isSpeakToolName(normalizedName);
}
