import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import {
  resolveSshHostConfig,
  type SshHostConfig,
} from "./ssh-host-config.js";
import { SshTunnel } from "./ssh-process.js";
export { isSshHostUri } from "./ssh-host-config.js";
import { ensureRemoteDaemon } from "./remote-daemon.js";
import { createNodeWebSocketFactory } from "../utils/client.js";

export interface ConnectViaSshOptions {
  /** Connect timeout in milliseconds. */
  timeoutMs?: number;
  /** CLI client id for the hello handshake. */
  clientId: string;
  /** CLI version reported in the hello handshake. */
  appVersion: string;
  /** @getpaseo/cli version to install on the remote if Paseo is missing. */
  version?: string;
  /** Progress callback for ensure/launch status. */
  onProgress?: (message: string) => void;
  /** Override the WebSocket factory (for tests). */
  webSocketFactory?: (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike;
}

/**
 * Connect to a remote Paseo daemon over SSH. Resolves the {@link SshHostConfig}
 * from an `ssh://` URI, ensures a daemon is running on the remote host
 * (installing Paseo first if needed), opens an SSH local port-forward, and
 * returns a connected {@link DaemonClient} whose traffic is tunneled.
 *
 * The tunnel is reaped when the client is closed or the process exits.
 */
export async function connectViaSsh(
  host: string,
  options: ConnectViaSshOptions,
): Promise<DaemonClient> {
  const config = resolveSshHostConfig(host);
  if (!config) {
    throw new Error(`Not an SSH host URI: ${host}`);
  }
  return connectViaSshConfig(config, options);
}

function sshControlPath(config: { host: string; port: number; user?: string }): string {
  const key = `${config.user ?? ""}@${config.host}:${config.port}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return path.join(tmpdir(), `paseo-ssh-${hash}.sock`);
}

/** Connect using an already-resolved {@link SshHostConfig}. */
export async function connectViaSshConfig(
  config: SshHostConfig,
  options: ConnectViaSshOptions,
): Promise<DaemonClient> {
  const tty = process.stdin.isTTY === true;
  const controlPath = sshControlPath(config);
  const sshOptions = { controlPath, ...(tty ? { tty } : {}) };

  await ensureRemoteDaemon({
    config,
    version: options.version,
    onProgress: options.onProgress,
    ...sshOptions,
  });

  const tunnel = await SshTunnel.open(config, config.remotePort, sshOptions);

  const url = `ws://127.0.0.1:${tunnel.localPort}/ws`;
  const webSocketFactory = options.webSocketFactory ?? createNodeWebSocketFactory();

  const client = new DaemonClient({
    url,
    clientId: options.clientId,
    clientType: "cli",
    appVersion: options.appVersion,
    connectTimeoutMs: options.timeoutMs,
    webSocketFactory: (
      target: string,
      wsOptions?: { headers?: Record<string, string>; protocols?: string[] },
    ) => webSocketFactory(target, { headers: wsOptions?.headers }),
    reconnect: { enabled: false },
  });

  // Reap the tunnel when the client is closed. The tunnel also registers its
  // own process-exit handler, so short-lived commands that never call close()
  // still clean up.
  const unsubscribe = client.subscribeConnectionStatus((state) => {
    if (state.status === "disposed") {
      tunnel.close();
      unsubscribe();
    }
  });

  try {
    await client.connect();
  } catch (error) {
    tunnel.close();
    throw error;
  }

  return client;
}
