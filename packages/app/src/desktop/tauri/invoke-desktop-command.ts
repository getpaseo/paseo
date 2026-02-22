import { getTauri } from "@/utils/tauri";

export async function invokeDesktopCommand<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const invoke = getTauri()?.core?.invoke;
  if (typeof invoke !== "function") {
    throw new Error("Tauri invoke() is unavailable in this environment.");
  }

  return (await invoke(command, args)) as T;
}
