import { requireNativeModule } from "expo-modules-core";
import type { HostConnection } from "@/types/host-connection";
import {
  preparePairingCertificateWithApi,
  type PairingCertificateApi,
} from "./pairing-client-certificate";

const certificates = requireNativeModule<PairingCertificateApi>("PaseoMtls");

export function preparePairingCertificate(connection: HostConnection): Promise<boolean> {
  return preparePairingCertificateWithApi(connection, certificates);
}
