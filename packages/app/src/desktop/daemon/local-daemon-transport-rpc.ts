import {
  closeLocalTransportSession,
  listenToLocalTransportEvents,
  openLocalTransportSession,
  sendLocalTransportMessage,
} from "./desktop-daemon";

import type { DaemonTransportBridge as LocalDaemonTransportRpc } from "@/hosts/daemon-transport-bridge";
export type {
  BridgeDaemonTransportEvent as LocalDaemonTransportEvent,
  DaemonTransportBridge as LocalDaemonTransportRpc,
} from "@/hosts/daemon-transport-bridge";

export const defaultLocalDaemonTransportRpc: LocalDaemonTransportRpc = {
  openSession: openLocalTransportSession,
  listenToEvents: listenToLocalTransportEvents,
  sendMessage: sendLocalTransportMessage,
  closeSession: closeLocalTransportSession,
};
