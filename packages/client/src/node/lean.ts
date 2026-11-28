import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { DaemonClientCore, type DaemonClientConfig } from "../daemon-client-core.js";
import { leanProtocolCodec } from "../daemon-protocol-codec-lean.js";
import { HostTransportBudget } from "./buffering.js";
import { createHostTransportFactory, type HostTransportOptions } from "./transport.js";

export { parseHostTarget };
export { HostTransportBudget } from "./buffering.js";
export { createHostTransportFactory, type HostTransportOptions } from "./transport.js";
export type { SshTunnel } from "./ssh-tunnel.js";
export { createSshTunnel, resolveSshFailureDetail } from "./ssh-tunnel.js";
export { DaemonClientCore };
export {
  createTerminalActions,
  type PaseoTerminal,
  type PaseoTerminalActions,
} from "../terminals/index.js";

/**
 * Node host client that uses envelope-level protocol parsing instead of loading
 * the 11.5 MB AOT validator, full Zod message schemas, or relay E2EE upfront.
 * Relay E2EE is still loaded dynamically when connecting to a pairing offer.
 */
export function createLeanHostClient(
  connection: string,
  config: Omit<DaemonClientConfig, "url"> & HostTransportOptions,
  budget?: HostTransportBudget,
): DaemonClientCore {
  const target = parseHostTarget(connection);
  const { webSocketAgent, transportFactory, ...clientConfig } = config;
  return new DaemonClientCore({
    ...clientConfig,
    protocolCodec: clientConfig.protocolCodec ?? leanProtocolCodec,
    url: "ws://host-connector/ws",
    ...(target.password ? { password: target.password } : {}),
    transportFactory:
      transportFactory ?? createHostTransportFactory(connection, budget, { webSocketAgent }),
  });
}
