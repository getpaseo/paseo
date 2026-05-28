import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeWebSocketFactory, type NodeWebSocketFactory } from "./node-ws-factory";

export async function loadDaemonClientConstructor<ClientConfig, ClientInstance>(): Promise<
  new (config: ClientConfig) => ClientInstance
> {
  const repoRoot = path.resolve(__dirname, "../../../../");
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, "packages/client/dist/daemon-client.js"),
  ).href;
  const mod = (await import(moduleUrl)) as {
    DaemonClient: new (config: ClientConfig) => ClientInstance;
  };
  return mod.DaemonClient;
}

interface E2EDaemonClientConfig {
  url: string;
  clientId: string;
  clientType: "cli";
  appVersion?: string;
  webSocketFactory?: NodeWebSocketFactory;
}

function resolveDaemonWsUrl(): string {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error("E2E_DAEMON_PORT is not set.");
  }
  if (daemonPort === "6767") {
    throw new Error("E2E_DAEMON_PORT must not point at the developer daemon.");
  }
  return `ws://127.0.0.1:${daemonPort}/ws`;
}

export interface ConnectDaemonClientOptions {
  clientIdPrefix: string;
  appVersion?: string;
}

/**
 * Connects an in-test daemon client over the isolated E2E daemon's WebSocket.
 * The port-6767 guard keeps tests off the developer daemon. Each helper passes
 * its own typed client interface as the generic.
 */
export async function connectDaemonClient<ClientInstance extends { connect(): Promise<void> }>(
  options: ConnectDaemonClientOptions,
): Promise<ClientInstance> {
  const DaemonClient = await loadDaemonClientConstructor<E2EDaemonClientConfig, ClientInstance>();
  const client = new DaemonClient({
    url: resolveDaemonWsUrl(),
    clientId: `${options.clientIdPrefix}-${randomUUID()}`,
    clientType: "cli",
    appVersion: options.appVersion,
    webSocketFactory: createNodeWebSocketFactory(),
  });
  await client.connect();
  return client;
}
