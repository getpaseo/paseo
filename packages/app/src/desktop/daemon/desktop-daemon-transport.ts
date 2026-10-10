import { createBridgeDaemonTransportFactory } from "@/hosts/bridge-daemon-transport";
import {
  defaultLocalDaemonTransportRpc,
  type LocalDaemonTransportRpc,
} from "./local-daemon-transport-rpc";
export { buildBridgeDaemonTransportUrl as buildDesktopDaemonTransportUrl } from "@/hosts/bridge-daemon-transport";

/** Connect desktop IPC to the shared daemon transport lifecycle. */
export function createDesktopDaemonTransportFactory(
  rpc: LocalDaemonTransportRpc = defaultLocalDaemonTransportRpc,
) {
  return createBridgeDaemonTransportFactory(rpc);
}
