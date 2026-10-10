import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import { createBridgeDaemonTransportFactory } from "@/hosts/bridge-daemon-transport";
import { createRemoteSshHostConnection } from "@/types/host-connection";
import type { BridgeDaemonTransportEvent } from "@/hosts/daemon-transport-bridge";
import type { SshKeyImportBridge } from "./ssh-key-import-model";

interface SshNativeModule extends SshKeyImportBridge {
  remove(id: string): Promise<void>;
  open(sessionId: string, credentialId: string, target: SshTarget): Promise<void>;
  send(sessionId: string, text: string | null, binary: string | null): Promise<void>;
  close(sessionId: string): Promise<void>;
  addListener(
    name: "transportEvent",
    handler: (event: BridgeDaemonTransportEvent) => void,
  ): EventSubscription;
}
export interface SshTarget {
  host: string;
  sshPort?: number;
  daemonPort?: number;
}
const native = requireOptionalNativeModule<SshNativeModule>("PaseoSsh");
export const supportsSshKeyImport = true;
export const isSshAvailable = () => native !== null;

/** Select Android's native SSH bridge for probes and ordinary host reconnection alike. */
export function createSshTransportFactory() {
  if (!native) return null;
  const bridge = native;
  return createBridgeDaemonTransportFactory({
    openSession: async ({ sessionId, target }) => {
      if (target.transportType !== "ssh")
        throw new Error("Android only supports SSH through this bridge.");
      const connection = createRemoteSshHostConnection(target);
      await bridge.open(sessionId, connection.id, target);
    },
    listenToEvents: async (handler) => {
      const subscription = bridge.addListener("transportEvent", handler);
      return () => subscription.remove();
    },
    sendMessage: ({ sessionId, text, binaryBase64 }) =>
      bridge.send(sessionId, text ?? null, binaryBase64 ?? null),
    closeSession: (id) => bridge.close(id),
  });
}

/** Erase imported secrets when the corresponding connection leaves the host registry. */
export async function removeSshCredentials(id: string): Promise<void> {
  await native?.remove(id);
}

/** Fail explicitly on an old binary without the native module. */
export function getSshKeyImportBridge(): SshKeyImportBridge {
  if (!native) throw new Error("Update the Android app to import SSH keys.");
  return native;
}
