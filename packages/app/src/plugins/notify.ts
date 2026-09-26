import type { PluginNotifier } from "@getpaseo/plugin/client";
import { getAppToastApi } from "@/contexts/app-toast";

function show(message: string, variant: "success" | "info"): void {
  const text = message.trim();
  if (!text) return;
  getAppToastApi()?.show(text, { variant });
}

export function createPluginNotifier(): PluginNotifier {
  return {
    success: (message) => show(message, "success"),
    info: (message) => show(message, "info"),
    error: (message) => {
      const text = message.trim();
      if (text) getAppToastApi()?.error(text);
    },
  };
}
