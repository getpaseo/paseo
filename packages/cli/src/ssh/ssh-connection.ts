import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { resolveSshHostConfig, type SshHostConfig } from "./ssh-host-config.js";
import { SshTunnel, createTerminalAskpassScript } from "./ssh-process.js";
export { isSshHostUri } from "./ssh-host-config.js";
import { buildEnsureScript } from "./remote-daemon.js";
import { createNodeWebSocketFactory } from "../utils/client.js";
import { resolveCliVersion } from "../version.js";

export interface ConnectViaSshOptions {
  /** Connect timeout in milliseconds. */
  timeoutMs?: number;
  /** CLI client id for the hello handshake. */
  clientId: string;
  /** CLI version reported in the hello handshake. */
  appVersion: string;
  /**
   * @getpaseo/cli version to install on the remote if Paseo is missing.
   * Defaults to this CLI's own version so both ends run the same build; the
   * remote falls back to the latest release when that version is not
   * published, which is the normal case for a source checkout.
   */
  version?: string;
  /** Progress callback for ensure/launch status. */
  onProgress?: (message: string) => void;
  /** Override the WebSocket factory (for tests). */
  webSocketFactory?: (url: string, options?: { headers?: Record<string, string> }) => WebSocketLike;
}

/**
 * Connect to a remote Paseo daemon over SSH. Resolves the {@link SshHostConfig}
 * from an `ssh://` URI, opens a single SSH connection that both ensures a
 * daemon is running on the remote host (installing Paseo first if needed) and
 * forwards the daemon port to a local port. Returns a connected
 * {@link DaemonClient} whose traffic is tunneled.
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

/** Connect using an already-resolved {@link SshHostConfig}. */
export async function connectViaSshConfig(
  config: SshHostConfig,
  options: ConnectViaSshOptions,
): Promise<DaemonClient> {
  const version = options.version ?? config.packageVersion ?? resolveCliVersion();
  const askpass = createTerminalAskpassScript();
  const ensureScript = buildEnsureScript(config, version);

  let tunnel: SshTunnel;
  try {
    tunnel = await SshTunnel.open(config, config.remotePort, {
      ensureScript,
      askpassPath: askpass.path,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  } finally {
    // SSH has either authenticated or given up by now; the script is no longer
    // needed and should not outlive a failed connect.
    askpass.cleanup();
  }

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
    ) => webSocketFactory(target, wsOptions),
    // Reconnecting is pointless once the tunnel is gone: the local port stops
    // being served and no retry can bring it back.
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
