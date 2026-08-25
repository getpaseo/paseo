/**
 * Paseo daemon client lifecycle manager.
 *
 * Phase 1: type-level integration with @getpaseo/client.
 * Runtime DaemonClient construction is deferred until OhmUrl resolver
 * support for npm JS modules is available. The class structure mirrors
 * the RN client lifecycle for drop-in compatibility.
 */

import type { DaemonClient, DaemonEvent } from '@getpaseo/client';
import type { ServerInfoStatusPayload } from '@getpaseo/protocol/messages';
import { ConnectionModel, ServerInfo } from '../models/connection-model';
import { AppConstants } from '../common/constants';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

interface LastConnection {
  host: string;
  port: number;
}

/** Stub transport type until OhmUrl resolution for npm modules is ready. */
interface HarmonyTransport {
  send: (data: string | Uint8Array | ArrayBuffer) => void;
  close: (code?: number, reason?: string) => void;
  onMessage: (handler: (data: ESObject) => void) => () => void;
  onOpen: (handler: () => void) => () => void;
  onClose: (handler: (event?: ESObject) => void) => () => void;
  onError: (handler: (event?: ESObject) => void) => () => void;
}

export class PaseoClientLifecycle {
  readonly connection: ConnectionModel = new ConnectionModel();
  // Phase 1: client is typed as DaemonClient for API compatibility,
  // but constructed at runtime via dynamic JS import (pending OhmUrl support).
  private _client: DaemonClient | null = null;

  get client(): DaemonClient | null {
    return this._client;
  }

  async connect(host: string, port: number = AppConstants.DEFAULT_PORT, password?: string): Promise<void> {
    this.connection.setConnecting();

    // Phase 1: connection logic is stubbed until npm runtime integration is complete.
    // The DaemonClient constructor and transport wiring will be activated once
    // the ArkTS OhmUrl resolver supports npm JS modules.
    const info: ServerInfo = {
      serverId: 'pending',
      hostname: host,
      version: '0.0.0',
    };
    this.connection.setConnected(info);

    // Phase 1: no real DaemonClient is constructed (npm JS runtime not
    // available in ArkTS). The connection model status drives UI navigation;
    // _client remains null until wire integration is complete.
    await this.saveLastConnection(host, port);
  }

  disconnect(): void {
    this._client = null;
    this.connection.setDisconnected();
  }

  async loadLastConnection(): Promise<LastConnection | null> {
    try {
      const ctx: common.UIAbilityContext = getContext() as common.UIAbilityContext;
      const prefs: preferences.Preferences = await preferences.getPreferences(ctx, 'paseo');
      const host: string = (await prefs.get(AppConstants.PREF_LAST_HOST, '')) as string;
      const port: number = (await prefs.get(AppConstants.PREF_LAST_PORT, AppConstants.DEFAULT_PORT)) as number;
      if (host !== '') {
        const result: LastConnection = { host: host, port: port };
        return result;
      }
    } catch (_e) {
      // Preferences not available (first launch)
    }
    return null;
  }

  private async saveLastConnection(host: string, port: number): Promise<void> {
    try {
      const ctx: common.UIAbilityContext = getContext() as common.UIAbilityContext;
      const prefs: preferences.Preferences = await preferences.getPreferences(ctx, 'paseo');
      await prefs.put(AppConstants.PREF_LAST_HOST, host);
      await prefs.put(AppConstants.PREF_LAST_PORT, port);
      await prefs.flush();
    } catch (_e) {
      // Non-critical — silently fail
    }
  }
}
