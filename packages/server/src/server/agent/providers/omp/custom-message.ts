import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;

const HIDDEN_OMP_CUSTOM_TYPES = new Set(["xdev-mount-notice"]);

export function shouldDisplayOmpCustomMessage(message: OmpCustomMessage): boolean {
  if (Reflect.get(message, "display") === false) {
    return false;
  }
  return !HIDDEN_OMP_CUSTOM_TYPES.has(String(Reflect.get(message, "customType") ?? ""));
}
