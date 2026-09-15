import type { FingerprintWarning, SpawnMspConnectionOptions } from "@muse-code/sdk";
import { spawnMspConnection } from "@muse-code/sdk";

import { resolveDaemonVersion } from "../../../daemon-version.js";

/** MSP `clientInfo.name`: constrained to `[a-z0-9_]+` by the handshake. */
export const MUSE_MSP_CLIENT_NAME = "paseo";

/**
 * Minimal wire shapes consumed from `muse serve`. The SDK barrel does not
 * export its generated wire types, so these intentionally cover only the
 * fields Paseo reads; callers validate rows before trusting them.
 */
export interface MuseModelCatalogEntry {
  readonly modelId?: unknown;
  readonly displayLabel?: unknown;
  readonly description?: unknown;
  readonly isDefault?: unknown;
  readonly contextLimit?: unknown;
}

export interface MuseModelListResult {
  readonly models?: readonly MuseModelCatalogEntry[];
}

export interface MuseInitializeResult {
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
  readonly sessionDurability?: string;
  readonly schema?: { readonly fingerprint?: string };
  readonly grantedCapabilities?: readonly string[];
}

export interface MuseHostNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface MuseHostServerRequest {
  readonly requestId: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface MuseHostExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface MuseHostConnection {
  readonly initializeResult: MuseInitializeResult;
  readonly fingerprintWarning: FingerprintWarning | undefined;
  command(method: string, params: Record<string, unknown>): Promise<unknown>;
  modelList(): Promise<MuseModelListResult>;
  onNotification(handler: (event: MuseHostNotification) => void): void;
  onServerRequest(
    handler: (request: MuseHostServerRequest) => Promise<Record<string, unknown>>,
  ): void;
  onExit(handler: (exit: MuseHostExit) => void): void;
  close(): Promise<void>;
}

export interface MuseHostSpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: (chunk: string) => void;
}

export type MuseHostSpawner = (options: MuseHostSpawnOptions) => Promise<MuseHostConnection>;

function resolveClientVersion(): string {
  try {
    return resolveDaemonVersion();
  } catch {
    return "0.0.0";
  }
}

/**
 * Spawn one SDK-owned `muse serve` host and complete the MSP handshake.
 * The SDK owns the child lifecycle: EOF on stdin, a bounded drain window,
 * then SIGTERM followed by SIGKILL.
 */
export const spawnMuseHost: MuseHostSpawner = async (options) => {
  const spawnOptions: SpawnMspConnectionOptions = {
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
  };
  const handshake = spawnMspConnection(spawnOptions);
  let spawned;
  try {
    spawned = await handshake.initialize({
      clientInfo: { name: MUSE_MSP_CLIENT_NAME, version: resolveClientVersion() },
    });
  } catch (error) {
    await handshake.close().catch(() => undefined);
    throw error;
  }
  return {
    initializeResult: spawned.initializeResult as unknown as MuseInitializeResult,
    fingerprintWarning: spawned.fingerprintWarning,
    command: (method, params) => spawned.connection.command(method, params),
    modelList: async () =>
      (await spawned.connection.command("model/list", {})) as unknown as MuseModelListResult,
    onNotification: (handler) => {
      spawned.connection.onNotification((notification) => {
        handler({
          method: notification.method,
          params: notification.params ?? {},
        });
      });
    },
    onServerRequest: (handler) => {
      spawned.connection.onServerRequest(async (request) =>
        handler({
          requestId: request.id,
          method: request.method,
          params: request.params ?? {},
        }),
      );
    },
    onExit: (handler) => {
      void spawned.exited.then(
        (exit) => handler({ code: exit.code, signal: exit.signal }),
        () => handler({ code: null, signal: null }),
      );
    },
    close: async () => {
      await spawned.close();
    },
  };
};
