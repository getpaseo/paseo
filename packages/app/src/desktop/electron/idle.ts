import { invokeDesktopCommand } from "@/desktop/electron/invoke";

const DESKTOP_SYSTEM_IDLE_COMMAND = "desktop_get_system_idle_time";

function isValidIdleTimeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export async function getDesktopSystemIdleTimeMs(): Promise<number | null> {
  try {
    const idleTimeMs = await invokeDesktopCommand<unknown>(DESKTOP_SYSTEM_IDLE_COMMAND);
    if (!isValidIdleTimeMs(idleTimeMs)) {
      console.warn("[DesktopIdle] Invalid system idle time", idleTimeMs);
      return null;
    }
    return idleTimeMs;
  } catch (error) {
    console.warn("[DesktopIdle] Failed to read system idle time", error);
    return null;
  }
}
