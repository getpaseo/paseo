const DESKTOP_SYSTEM_IDLE_COMMAND = "desktop_get_system_idle_time";

export type DesktopIpcInvoker = <T>(command: string) => Promise<T>;

function isValidIdleTimeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export async function readDesktopSystemIdleTimeMs(
  invoke: DesktopIpcInvoker,
): Promise<number | null> {
  try {
    const idleTimeMs = await invoke<unknown>(DESKTOP_SYSTEM_IDLE_COMMAND);
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
