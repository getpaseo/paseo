import type { SshKeyImportBridge } from "./ssh-key-import-model";
import { getIsElectron } from "@/constants/platform";
import { createDesktopDaemonTransportFactory } from "@/desktop/daemon/desktop-daemon-transport";

export const supportsSshKeyImport = false;
export const isSshAvailable = getIsElectron;
export const createSshTransportFactory = createDesktopDaemonTransportFactory;
/** Mobile credentials are device-local; other platforms own their credentials outside Paseo. */
export async function removeSshCredentials(_id: string): Promise<void> {}

/** Only Android owns imported SSH credentials. */
export function getSshKeyImportBridge(): SshKeyImportBridge {
  throw new Error("SSH key import is only available on Android.");
}
