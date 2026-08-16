export type PluginPageState = "offline" | "unsupported" | "loading" | "error" | "empty" | "ready";

export function resolvePluginPageState(input: {
  connected: boolean;
  supported: boolean;
  loading: boolean;
  error: boolean;
  pluginCount: number;
}): PluginPageState {
  if (!input.connected) return "offline";
  if (!input.supported) return "unsupported";
  if (input.loading) return "loading";
  if (input.error) return "error";
  return input.pluginCount === 0 ? "empty" : "ready";
}
