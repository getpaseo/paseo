import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { PluginService } from "../../plugin/service.js";
import {
  PluginDownloadRejectedError,
  PluginDownloadVerificationError,
  PluginNotInRegistryError,
  PluginRegistryUnavailableError,
} from "../../plugin/registry-client.js";
import {
  PluginEntryNotFoundError,
  PluginEntryUnavailableError,
  PluginNotInstalledError,
  PluginPathTraversalError,
} from "../../plugin/store.js";

export interface PluginSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface PluginSessionOptions {
  host: PluginSessionHost;
  pluginService: PluginService;
  logger: pino.Logger;
}

/**
 * Errors whose message is safe to put on the wire. Anything else — a raw
 * `EACCES`/`EISDIR` from the filesystem, say — carries the absolute
 * `$PASEO_HOME` path in its message, so the client gets a generic sentence and
 * the real error goes to the daemon log.
 */
function clientMessage(error: unknown, fallback: string): string {
  if (
    error instanceof PluginNotInstalledError ||
    error instanceof PluginEntryNotFoundError ||
    error instanceof PluginEntryUnavailableError ||
    error instanceof PluginPathTraversalError ||
    error instanceof PluginRegistryUnavailableError ||
    error instanceof PluginNotInRegistryError ||
    error instanceof PluginDownloadVerificationError ||
    error instanceof PluginDownloadRejectedError
  ) {
    return error.message;
  }
  return fallback;
}

/**
 * A client's read/write surface for installed plugins. Every handler answers
 * its request exactly once: a failed install or a broken registry comes back as
 * `error` on the response rather than tearing down the session.
 */
export class PluginSession {
  private readonly host: PluginSessionHost;
  private readonly pluginService: PluginService;
  private readonly logger: pino.Logger;

  constructor(options: PluginSessionOptions) {
    this.host = options.host;
    this.pluginService = options.pluginService;
    this.logger = options.logger;
  }

  async handleListRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.list.request" }>,
  ): Promise<void> {
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
        payload: {
          requestId: msg.requestId,
          plugins: [],
          error: clientMessage(error, "Could not read the plugin directory"),
        },
      });
    }
  }

  async handleGetEntryRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.get_entry.request" }>,
  ): Promise<void> {
    const base = { requestId: msg.requestId, pluginId: msg.pluginId, entry: msg.entry };
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
        payload: {
          ...base,
          html: null,
          error: clientMessage(error, "Could not read the plugin entry"),
        },
      });
    }
  }

  async handleBrowseRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.browse.request" }>,
  ): Promise<void> {
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
        payload: {
          requestId: msg.requestId,
          registryUrl,
          plugins: [],
          error: clientMessage(error, "Could not read the plugin registry"),
        },
      });
    }
  }

  async handleInstallRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.install.request" }>,
  ): Promise<void> {
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
        payload: {
          requestId: msg.requestId,
          plugin: null,
          error: clientMessage(error, "Could not install the plugin"),
        },
      });
    }
  }

  async handleUninstallRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.uninstall.request" }>,
  ): Promise<void> {
    const base = { requestId: msg.requestId, pluginId: msg.pluginId };
    try {
      await this.pluginService.uninstall(msg.pluginId);
      this.host.emit({ type: "plugins.uninstall.response", payload: { ...base, error: null } });
    } catch (error) {
      this.logger.warn({ err: error, pluginId: msg.pluginId }, "Failed to uninstall plugin");
      this.host.emit({
        type: "plugins.uninstall.response",
        payload: { ...base, error: clientMessage(error, "Could not uninstall the plugin") },
      });
    }
  }

  async handleSetEnabledRequest(
    msg: Extract<SessionInboundMessage, { type: "plugins.set_enabled.request" }>,
  ): Promise<void> {
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
        payload: {
          requestId: msg.requestId,
          plugin: null,
          error: clientMessage(error, "Could not change the plugin's enabled state"),
        },
      });
    }
  }
}
