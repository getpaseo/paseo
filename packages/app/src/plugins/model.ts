/**
 * The parts of the plugins UI that are pure: which support tier a host is in,
 * and how one fallible plugin action reports pending/success/failure. Kept out
 * of the React components so both are testable against a fake port.
 */

/**
 * Three states, not two. `useHostFeature` returns false both for a daemon
 * without the `plugins` capability and for a session that has not finished its
 * `server_info` handshake, and telling a disconnected user to upgrade is wrong.
 */
export type PluginsSupport = "unknown" | "unsupported" | "supported";

export function resolvePluginsSupport(input: {
  serverId: string | null;
  hasServerInfo: boolean;
  hasPluginsFeature: boolean;
}): PluginsSupport {
  if (!input.serverId || !input.hasServerInfo) {
    return "unknown";
  }
  return input.hasPluginsFeature ? "supported" : "unsupported";
}

export type PluginActionKind = "enable" | "disable" | "install" | "uninstall";

export type PluginActionRequest =
  | { kind: "enable" | "disable"; pluginId: string }
  | { kind: "install"; pluginId: string }
  | { kind: "uninstall"; pluginId: string };

interface PluginActionResult {
  error?: string | null;
}

/** The daemon calls a plugin action needs. Injected so tests can fake it. */
export interface PluginActionsPort {
  setEnabled(input: { pluginId: string; enabled: boolean }): Promise<PluginActionResult>;
  install(input: { pluginId: string }): Promise<PluginActionResult>;
  uninstall(input: { pluginId: string }): Promise<PluginActionResult>;
}

export interface PluginActionEffects {
  /**
   * Per plugin id, so two concurrent actions do not collapse into one spinner.
   * The kind is what the row is doing right now; null means idle.
   */
  setPending(pluginId: string, kind: PluginActionKind | null): void;
  setError(pluginId: string, message: string | null): void;
  notifySuccess(kind: PluginActionKind): void;
  /**
   * The installed list is a replica query refreshed by one `plugins.changed`
   * broadcast. Invalidating on settle is the affordance for the reconnect gap
   * that drops it.
   */
  refresh(): void;
}

export async function runPluginAction(input: {
  request: PluginActionRequest;
  port: PluginActionsPort | null;
  effects: PluginActionEffects;
  disconnectedMessage: string;
}): Promise<void> {
  const { request, port, effects } = input;
  effects.setError(request.pluginId, null);
  effects.setPending(request.pluginId, request.kind);
  try {
    if (!port) {
      throw new Error(input.disconnectedMessage);
    }
    const result = await callPort(port, request);
    if (result.error) {
      throw new Error(result.error);
    }
    effects.notifySuccess(request.kind);
  } catch (cause) {
    effects.setError(request.pluginId, cause instanceof Error ? cause.message : String(cause));
  } finally {
    effects.setPending(request.pluginId, null);
    effects.refresh();
  }
}

function callPort(
  port: PluginActionsPort,
  request: PluginActionRequest,
): Promise<PluginActionResult> {
  if (request.kind === "install") {
    return port.install({ pluginId: request.pluginId });
  }
  if (request.kind === "uninstall") {
    return port.uninstall({ pluginId: request.pluginId });
  }
  return port.setEnabled({ pluginId: request.pluginId, enabled: request.kind === "enable" });
}
