import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;

const HIDDEN_OMP_CUSTOM_TYPES = new Set(["xdev-mount-notice"]);
const OMP_DYNAMIC_DEVICE_MOUNT_PREFIX = "xd://: mounted ";
const OMP_DYNAMIC_DEVICE_INVENTORY_LINE = "xd:// device inventory changed.";

function customMessageText(message: OmpCustomMessage): string {
  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (
        !block ||
        typeof block !== "object" ||
        Array.isArray(block) ||
        Reflect.get(block, "type") !== "text" ||
        typeof Reflect.get(block, "text") !== "string"
      ) {
        return [];
      }
      return [Reflect.get(block, "text") as string];
    })
    .join("\n\n");
}

export function isOmpDynamicDeviceMountNoticeText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith(OMP_DYNAMIC_DEVICE_MOUNT_PREFIX)) {
    return true;
  }

  const lines = normalized.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => line.startsWith(OMP_DYNAMIC_DEVICE_MOUNT_PREFIX))) {
    return true;
  }
  return (
    lines[0]?.toLowerCase() === "<system-notice>" &&
    lines.some((line) => line.toLowerCase() === OMP_DYNAMIC_DEVICE_INVENTORY_LINE)
  );
}

export function isOmpDynamicDeviceMountNotice(
  message: OmpCustomMessage,
  text = customMessageText(message),
): boolean {
  return (
    HIDDEN_OMP_CUSTOM_TYPES.has(String(Reflect.get(message, "customType") ?? "")) ||
    isOmpDynamicDeviceMountNoticeText(text)
  );
}

export function shouldDisplayOmpCustomMessage(message: OmpCustomMessage): boolean {
  if (Reflect.get(message, "display") === false) {
    return false;
  }
  return !isOmpDynamicDeviceMountNotice(message);
}
