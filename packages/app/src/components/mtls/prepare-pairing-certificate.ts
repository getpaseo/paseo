import type { HostConnection } from "@/types/host-connection";

export async function preparePairingCertificate(_connection: HostConnection): Promise<boolean> {
  return true;
}
