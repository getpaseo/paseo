export { createHostChannelTransport } from "../hosts/index.js";
export { HostTransportBudget } from "./buffering.js";
export { parseHostTarget } from "@getpaseo/protocol/host-target";
export type { SshTunnel } from "./ssh-tunnel.js";
export { createSshTunnel, resolveSshFailureDetail } from "./ssh-tunnel.js";
export { createHostTransportFactory, type HostTransportOptions } from "./transport.js";
export { createLeanHostClient } from "./lean.js";

import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { DaemonClient, type DaemonClientConfig } from "../daemon-client.js";
import { HostTransportBudget } from "./buffering.js";
import { createHostTransportFactory, type HostTransportOptions } from "./transport.js";

export function createHostClient(
  connection: string,
  config: Omit<DaemonClientConfig, "url"> & HostTransportOptions,
  budget?: HostTransportBudget,
): DaemonClient {
  const target = parseHostTarget(connection);
  const { webSocketAgent, transportFactory, ...clientConfig } = config;
  return new DaemonClient({
    ...clientConfig,
    url: "ws://host-connector/ws",
    ...(target.password ? { password: target.password } : {}),
    transportFactory:
      transportFactory ?? createHostTransportFactory(connection, budget, { webSocketAgent }),
  });
}
