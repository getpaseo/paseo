import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { PluginService } from "../../plugin/service.js";

export interface PluginSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface PluginSessionOptions {
  host: PluginSessionHost;
  /** Absent when the daemon runs without a plugin directory; every RPC then errors. */
  pluginService: PluginService | null | undefined;
  logger: pino.Logger;
}

const PLUGINS_UNAVAILABLE = "Plugins are not available on this daemon";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A client's read/write surface for installed plugins. Every handler answers
 * its request exactly once: a failed install or a broken registry comes back as
 * `error` on the response rather than tearing down the session.
 */
export class PluginSession {
  private readonly host: PluginSessionHost;
  private readonly pluginService: PluginService | null;
  private readonly logger: pino.Logger;

  constructor(options: PluginSessionOptions) {
    this.host = options.host;
    this.pluginService = options.pluginService ?? null;
    this.logger = options.logger;
  }

  async handleListRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.list.request" }>,
  ): Promise<void> {
    if (!this.pluginService) {
      this.host.emit({
        type: "plugins.list.response",
        payload: { requestId: msg.requestId, plugins: [], error: PLUGINS_UNAVAILABLE },
      });
      return;
    }
    try {
      const plugins = await this.pluginService.list();
      this.host.emit({
        type: "plugins.list.response",
        payload: { requestId: msg.requestId, plugins, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to list plugins");
      this.host.emit({
        type: "plugins.list.response",
        payload: { requestId: msg.requestId, plugins: [], error: describe(error) },
      });
    }
  }

  async handleGetEntryRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.get_entry.request" }>,
  ): Promise<void> {
    const base = { requestId: msg.requestId, pluginId: msg.pluginId, entry: msg.entry };
    if (!this.pluginService) {
      this.host.emit({
        type: "plugins.get_entry.response",
        payload: { ...base, html: null, error: PLUGINS_UNAVAILABLE },
      });
      return;
    }
    try {
      const html = await this.pluginService.getEntry(msg.pluginId, msg.entry);
      this.host.emit({
        type: "plugins.get_entry.response",
        payload: { ...base, html, error: null },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, pluginId: msg.pluginId, entry: msg.entry },
        "Failed to read plugin entry",
      );
      this.host.emit({
        type: "plugins.get_entry.response",
        payload: { ...base, html: null, error: describe(error) },
      });
    }
  }

  async handleBrowseRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.browse.request" }>,
  ): Promise<void> {
    if (!this.pluginService) {
      this.host.emit({
        type: "plugins.browse.response",
        payload: {
          requestId: msg.requestId,
          registryUrl: "",
          plugins: [],
          error: PLUGINS_UNAVAILABLE,
        },
      });
      return;
    }
    const registryUrl = this.pluginService.registryUrl;
    try {
      const plugins = await this.pluginService.browse({ refresh: msg.refresh === true });
      this.host.emit({
        type: "plugins.browse.response",
        payload: { requestId: msg.requestId, registryUrl, plugins, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error, registryUrl }, "Failed to browse plugin registry");
      this.host.emit({
        type: "plugins.browse.response",
        payload: { requestId: msg.requestId, registryUrl, plugins: [], error: describe(error) },
      });
    }
  }

  async handleInstallRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.install.request" }>,
  ): Promise<void> {
    if (!this.pluginService) {
      this.host.emit({
        type: "plugins.install.response",
        payload: { requestId: msg.requestId, plugin: null, error: PLUGINS_UNAVAILABLE },
      });
      return;
    }
    try {
      const plugin = await this.pluginService.install(msg.pluginId);
      this.host.emit({
        type: "plugins.install.response",
        payload: { requestId: msg.requestId, plugin, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error, pluginId: msg.pluginId }, "Failed to install plugin");
      this.host.emit({
        type: "plugins.install.response",
        payload: { requestId: msg.requestId, plugin: null, error: describe(error) },
      });
    }
  }

  async handleUninstallRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.uninstall.request" }>,
  ): Promise<void> {
    const base = { requestId: msg.requestId, pluginId: msg.pluginId };
    if (!this.pluginService) {
      this.host.emit({
        type: "plugins.uninstall.response",
        payload: { ...base, error: PLUGINS_UNAVAILABLE },
      });
      return;
    }
    try {
      await this.pluginService.uninstall(msg.pluginId);
      this.host.emit({ type: "plugins.uninstall.response", payload: { ...base, error: null } });
    } catch (error) {
      this.logger.warn({ err: error, pluginId: msg.pluginId }, "Failed to uninstall plugin");
      this.host.emit({
        type: "plugins.uninstall.response",
        payload: { ...base, error: describe(error) },
      });
    }
  }

  async handleSetEnabledRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.set_enabled.request" }>,
  ): Promise<void> {
    if (!this.pluginService) {
      this.host.emit({
        type: "plugins.set_enabled.response",
        payload: { requestId: msg.requestId, plugin: null, error: PLUGINS_UNAVAILABLE },
      });
      return;
    }
    try {
      const plugin = await this.pluginService.setEnabled(msg.pluginId, msg.enabled);
      this.host.emit({
        type: "plugins.set_enabled.response",
        payload: { requestId: msg.requestId, plugin, error: null },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, pluginId: msg.pluginId, enabled: msg.enabled },
        "Failed to change plugin enabled state",
      );
      this.host.emit({
        type: "plugins.set_enabled.response",
        payload: { requestId: msg.requestId, plugin: null, error: describe(error) },
      });
    }
  }
}
